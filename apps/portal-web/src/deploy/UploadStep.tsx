import { useState } from "react";
import { Alert, Anchor, Code, Stack, Text } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { useQuery } from "@tanstack/react-query";
import type { DeployReport, UploadVersionResponse } from "@azx-pbc/shared";
import { type BundlePlan, planBundle } from "@azx-pbc/shared/bundlePlan";
import { toDeployReport } from "./report";
import { manifestQuery } from "../api/queries";
import { useUploadVersion } from "../api/mutations";
import { Icon } from "../components/Icon";
import { useDeployment } from "../lib/deployment";
import {
  BundleTooLargeError,
  type LoadedBundle,
  buildCanonicalZip,
  loadFolder,
  loadZip,
} from "./archive";
import { FixBundleFlow } from "./FixBundleFlow";

const MB = 1024 * 1024;

type Source = { kind: "zip"; file: File } | { kind: "folder"; files: File[] };

/** Everything the confirm step needs, computed once from a drop. */
interface Prepared {
  loaded: LoadedBundle;
  plan: BundlePlan;
  source: Source;
  name: string;
}

/**
 * The deploy sub-flow (ADR-0038): accept a dropped folder or zip, run the
 * layout planner, and — unless the archive is already perfect — show the confirm
 * step before building the canonical zip and uploading. A `canonical` plan skips
 * the gate and uploads unchanged.
 */
export function UploadStep({
  slug,
  authenticated,
  onDone,
}: {
  slug: string;
  authenticated: boolean;
  onDone: (res: UploadVersionResponse) => void;
}) {
  const upload = useUploadVersion();
  const { deployMaxBundleMb } = useDeployment();
  const manifest = useQuery({ ...manifestQuery(slug), enabled: authenticated });
  const offlineScope = manifest.data?.capabilities.offline?.scope;

  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const maxBundleBytes = deployMaxBundleMb !== null ? deployMaxBundleMb * MB : null;
  // Plan only once the manifest (and its offline scope) is known (ADR-0038 #12):
  // planning with an unresolved scope would strip a correct offline build's prefix.
  const notReady = authenticated && manifest.isPending;

  async function onDrop(files: File[]) {
    setError(null);
    setReading(true);
    try {
      const source: Source = asSource(files);
      const loaded =
        source.kind === "zip"
          ? await loadZip(source.file, maxBundleBytes)
          : await loadFolder(source.files, maxBundleBytes);
      const plan = planBundle(
        loaded.entries,
        { declaredDir: loaded.declaredDir, offlineScope },
        loaded.htmlText,
      );

      // A perfect zip ships untouched; anything else (folder, re-root, drops) is
      // confirmed first — except that a folder is always re-zipped even when
      // clean, since there is no original archive to send.
      if (plan.outcome === "canonical" && source.kind === "zip") {
        doUpload(source.file, toDeployReport(plan));
      } else if (plan.outcome === "canonical") {
        doUpload(await buildCanonicalZip(loaded, plan), toDeployReport(plan));
      } else {
        setPrepared({ loaded, plan, source, name: sourceName(source) });
      }
    } catch (err) {
      setError(err instanceof BundleTooLargeError ? err.message : readErrorMessage(err));
    } finally {
      setReading(false);
    }
  }

  function rePlan(root: string) {
    if (!prepared) return;
    const { loaded, source } = prepared;
    // Thread the full context (ADR-0038 #8): dropping declaredDir/offlineScope
    // here would un-nest an offline build and lose the declared-dir justification.
    const plan = planBundle(
      loaded.entries,
      { declaredDir: loaded.declaredDir, offlineScope, forceRoot: root },
      loaded.htmlText,
    );
    setPrepared({ loaded, plan, source, name: prepared.name });
  }

  async function confirmDeploy() {
    if (!prepared) return;
    setError(null);
    try {
      doUpload(
        await buildCanonicalZip(prepared.loaded, prepared.plan),
        toDeployReport(prepared.plan),
      );
    } catch (err) {
      setError(readErrorMessage(err));
    }
  }

  function doUpload(file: File, report?: DeployReport) {
    upload.mutate(
      { slug, file, report },
      { onSuccess: onDone, onError: (e) => setError(e.message) },
    );
  }

  if (prepared) {
    return (
      <FixBundleFlow
        plan={prepared.plan}
        fileName={prepared.name}
        busy={upload.isPending}
        error={error}
        onPickRoot={rePlan}
        onDeploy={confirmDeploy}
        onCancel={() => {
          setPrepared(null);
          setError(null);
          upload.reset();
        }}
      />
    );
  }

  return (
    <Stack gap="sm">
      <Dropzone
        // No `accept` filter: a dropped *folder* recurses to html/css/js files,
        // none of which are `application/zip`, so an accept filter would silently
        // reject the whole folder (ADR-0038 #2). The flow classifies via asSource
        // and a stray non-zip lands in the planner's unsalvageable path.
        onDrop={onDrop}
        multiple
        loading={reading || upload.isPending}
        disabled={notReady}
      >
        <Stack align="center" gap={6} py={28} style={{ pointerEvents: "none" }}>
          <Icon name="upload" size={28} style={{ color: "var(--mantine-color-dark-2)" }} />
          <Text fw={500}>Drop your build output folder — or a zip of it</Text>
          <Text size="xs" c="dark.2">
            Usually <Code>dist/</Code>, <Code>build/</Code>, or <Code>out/</Code>. We&apos;ll find
            the site and fix common mistakes.
          </Text>
        </Stack>
      </Dropzone>
      <PickLinks onFiles={onDrop} disabled={reading || upload.isPending || notReady} />
      {error && (
        <Alert color="red" title="Couldn't read that upload" icon={<Icon name="alert" size={16} />}>
          {error}
        </Alert>
      )}
    </Stack>
  );
}

/**
 * Click-to-choose, for the people drag-and-drop doesn't reach. Both shapes the
 * dropzone accepts get an equal link: a directory picker and a file picker
 * filtered to zips. Offering only the folder one stranded anyone who already
 * has an archive and doesn't want to drag it.
 */
function PickLinks({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  return (
    <Text size="xs" c="dark.2" ta="center">
      or <PickLink onFiles={onFiles} disabled={disabled} label="choose a folder" directory /> ·{" "}
      <PickLink onFiles={onFiles} disabled={disabled} label="choose a zip" />
    </Text>
  );
}

/** One hidden input behind an anchor — a directory picker, or a zip file picker. */
function PickLink({
  onFiles,
  disabled,
  label,
  directory,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  label: string;
  /** Non-standard but widely supported directory-selection attributes. */
  directory?: boolean;
}) {
  return (
    <Anchor
      component="label"
      style={{ cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}
    >
      {label}
      <input
        type="file"
        hidden
        disabled={disabled}
        {...(directory
          ? ({ webkitdirectory: "", directory: "" } as Record<string, string>)
          : { accept: ".zip,application/zip" })}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          if (files.length) onFiles(files);
          e.currentTarget.value = "";
        }}
      />
    </Anchor>
  );
}

/** Classify a drop: a single `.zip` is an archive; anything else is a folder/file set. */
function asSource(files: File[]): Source {
  if (files.length === 1 && /\.zip$/i.test(files[0]!.name)) return { kind: "zip", file: files[0]! };
  return { kind: "folder", files };
}

function sourceName(source: Source): string {
  if (source.kind === "zip") return source.file.name;
  const first = source.files[0];
  const path = (first as (File & { path?: string }) | undefined)?.path ?? first?.webkitRelativePath;
  return path?.split("/").filter(Boolean)[0] ?? "your folder";
}

function readErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid|zip|central directory|signature/i.test(msg)
    ? "That doesn't look like a valid zip. Try dropping the build folder instead."
    : msg;
}
