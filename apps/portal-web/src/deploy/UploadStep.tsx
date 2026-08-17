import { useState } from "react";
import { Alert, Anchor, Code, Stack, Text } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { useQuery } from "@tanstack/react-query";
import type { UploadVersionResponse } from "@azx-pbc/shared";
import { type BundlePlan, planBundle } from "@azx-pbc/shared/bundlePlan";
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
        doUpload(source.file);
      } else if (plan.outcome === "canonical") {
        doUpload(await buildCanonicalZip(loaded, plan));
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
    const plan = planBundle(loaded.entries, { forceRoot: root }, loaded.htmlText);
    setPrepared({ loaded, plan, source, name: prepared.name });
  }

  async function confirmDeploy() {
    if (!prepared) return;
    setError(null);
    try {
      doUpload(await buildCanonicalZip(prepared.loaded, prepared.plan));
    } catch (err) {
      setError(readErrorMessage(err));
    }
  }

  function doUpload(file: File) {
    upload.mutate({ slug, file }, { onSuccess: onDone, onError: (e) => setError(e.message) });
  }

  if (prepared) {
    return (
      <FixBundleFlow
        plan={prepared.plan}
        fileName={prepared.name}
        busy={upload.isPending}
        onPickRoot={rePlan}
        onDeploy={confirmDeploy}
        onCancel={() => {
          setPrepared(null);
          upload.reset();
        }}
      />
    );
  }

  return (
    <Stack gap="sm">
      <Dropzone
        onDrop={onDrop}
        accept={["application/zip", "application/x-zip-compressed"]}
        multiple
        loading={reading || upload.isPending}
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
      <FolderPicker onFiles={onDrop} disabled={reading || upload.isPending} />
      {error && (
        <Alert color="red" title="Couldn't read that upload" icon={<Icon name="alert" size={16} />}>
          {error}
        </Alert>
      )}
    </Stack>
  );
}

/** A hidden directory input, for choosing a folder by click (drag covers the rest). */
function FolderPicker({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  return (
    <Text size="xs" c="dark.2" ta="center">
      or{" "}
      <Anchor
        component="label"
        style={{ cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}
      >
        choose a folder
        <input
          type="file"
          hidden
          disabled={disabled}
          // Non-standard but widely supported directory-selection attributes.
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            if (files.length) onFiles(files);
            e.currentTarget.value = "";
          }}
        />
      </Anchor>
    </Text>
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
