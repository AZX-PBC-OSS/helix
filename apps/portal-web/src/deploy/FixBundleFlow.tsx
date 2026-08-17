import { Alert, Box, Button, Code, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import type { BundlePlan, DropReason, Problem } from "@azx-pbc/shared/bundlePlan";
import { Icon } from "../components/Icon";
import { Hint, ToneBadge } from "../components/primitives";

/**
 * The confirm step (ADR-0038 decision 4): shown whenever the planner's outcome
 * isn't `canonical`. It states the assumption the SPA is about to act on — which
 * folder is the build, what gets dropped, what looks broken — and lets the user
 * pick a different root or back out before a single byte is uploaded. A perfect
 * zip never reaches this component.
 */
export function FixBundleFlow({
  plan,
  fileName,
  busy,
  error,
  onPickRoot,
  onDeploy,
  onCancel,
}: {
  plan: BundlePlan;
  /** The dropped file/folder name, for the header. */
  fileName: string;
  busy?: boolean;
  /** A deploy/upload error to surface (ADR-0038 #4) — the dropzone alert is gone by now. */
  error?: string | null;
  /** Re-plan against a different candidate root. */
  onPickRoot: (root: string) => void;
  onDeploy: () => void;
  onCancel: () => void;
}) {
  const blocked = plan.outcome === "unsalvageable";
  const dropCounts = countDrops(plan.drops);

  return (
    <Stack gap="md">
      <Text size="xs" c="dark.2">
        From <Code>{fileName}</Code>
      </Text>
      <Hint icon={headline(plan).icon} tone={headline(plan).tone}>
        {headline(plan).text}
      </Hint>

      {!blocked && (
        <Box>
          <Text size="xs" tt="uppercase" c="dark.2" fw={600} mb={6}>
            Will deploy {plan.files.length} file{plan.files.length === 1 ? "" : "s"}
            {plan.root ? (
              <>
                {" "}
                from <Code>{plan.root}</Code>
              </>
            ) : null}
          </Text>
          <FileTree paths={plan.files.map((f) => f.to)} />
        </Box>
      )}

      {plan.candidates.length > 1 && (
        <Box>
          <Text size="xs" tt="uppercase" c="dark.2" fw={600} mb={6}>
            {plan.outcome === "ambiguous"
              ? "Which folder is your build?"
              : "Use a different folder"}
          </Text>
          <Stack gap={6}>
            {plan.candidates.slice(0, 4).map((c) => (
              <UnstyledButton
                key={c.root || "(root)"}
                onClick={() => onPickRoot(c.root)}
                disabled={busy}
                style={{
                  border: `1px solid ${c.root === plan.root ? "var(--az-acc)" : "var(--az-line)"}`,
                  borderRadius: "var(--mantine-radius-md)",
                  padding: "8px 12px",
                  background: c.root === plan.root ? "var(--az-acc-dim)" : "transparent",
                }}
              >
                <Group gap={8} wrap="nowrap">
                  <Icon name="box" size={14} style={{ color: "var(--mantine-color-dark-2)" }} />
                  <Code fz={12}>{c.root || "/ (archive root)"}</Code>
                  {c.root === plan.root && (
                    <ToneBadge tone="live" style={{ padding: "1px 6px", fontSize: 9.5 }}>
                      CHOSEN
                    </ToneBadge>
                  )}
                </Group>
                {c.because.length > 0 && (
                  <Text size="xs" c="dark.2" mt={3}>
                    {c.because.join(" · ")}
                  </Text>
                )}
              </UnstyledButton>
            ))}
          </Stack>
        </Box>
      )}

      {plan.problems.map((p, i) => (
        <ProblemAlert key={i} problem={p} />
      ))}

      {dropCounts.length > 0 && (
        <Box>
          <Text size="xs" tt="uppercase" c="dark.2" fw={600} mb={6}>
            Dropped
          </Text>
          <Group gap={8}>
            {dropCounts.map(([reason, n]) => (
              <ToneBadge key={reason} tone={reason === "secret" ? "warn" : "neutral"} icon="x">
                {n} {DROP_LABEL[reason]}
              </ToneBadge>
            ))}
          </Group>
        </Box>
      )}

      {error && (
        <Alert color="red" title="Deploy failed" icon={<Icon name="alert" size={16} />}>
          {error}
        </Alert>
      )}

      <Group justify="flex-end" gap="sm" mt="xs">
        <Button variant="default" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={onDeploy}
          disabled={blocked}
          loading={busy}
          leftSection={<Icon name="upload" size={14} />}
        >
          Deploy this
        </Button>
      </Group>
    </Stack>
  );
}

const DROP_LABEL: Record<DropReason, string> = {
  junk: "junk files",
  "outside-root": "outside the build",
  "unsupported-type": "unsupported types",
  secret: "secret files",
  "unsafe-path": "unsafe paths",
};

function countDrops(drops: { reason: DropReason }[]): [DropReason, number][] {
  const counts = new Map<DropReason, number>();
  for (const d of drops) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return [...counts.entries()];
}

function headline(plan: BundlePlan): {
  icon: "check" | "alert" | "layers" | "box";
  tone: "info" | "warn" | "live";
  text: string;
} {
  switch (plan.outcome) {
    case "rerooted":
      return {
        icon: "layers",
        tone: "info",
        text: `This looks like more than just your build. We'll deploy the files in ${plan.root || "the root"} and drop the rest — check below, then deploy.`,
      };
    case "nested":
      return {
        icon: "box",
        tone: "info",
        text: "This app is served from a path prefix, so we'll nest your build under it. Review and deploy.",
      };
    case "ambiguous":
      return {
        icon: "alert",
        tone: "warn",
        text: "We couldn't tell which folder holds your build. Pick the right one below.",
      };
    case "unsalvageable":
      return {
        icon: "alert",
        tone: "warn",
        text: "We couldn't find a built site in this upload — there's no index.html. Build your app first, then upload the build output (e.g. dist/).",
      };
    case "canonical":
      return { icon: "check", tone: "live", text: "Looks good — ready to deploy." };
  }
}

function ProblemAlert({ problem }: { problem: Problem }) {
  switch (problem.kind) {
    case "secret-dropped":
      return (
        <Alert
          color="orange"
          icon={<Icon name="key" size={16} />}
          title="A secret file was left out"
        >
          <Code>{problem.path}</Code> was not uploaded. Rotate anything that was in it — a{" "}
          <Code>.env</Code> should never ship in a static bundle.
        </Alert>
      );
    case "missing-reference":
      return (
        <Alert
          color="yellow"
          icon={<Icon name="alert" size={16} />}
          title="A referenced file is missing"
        >
          <Code>{problem.file}</Code> references <Code>{problem.ref}</Code>, which isn't in the
          bundle. The page may render broken.
        </Alert>
      );
    case "scope-mismatch":
      return (
        <Alert
          color="yellow"
          icon={<Icon name="alert" size={16} />}
          title="Build doesn't match its offline scope"
        >
          This app is served from <Code>{problem.scope}</Code>, but the build sits at the root and
          uses absolute paths. Rebuild with <Code>base: &quot;./&quot;</Code> and{" "}
          <Code>outDir: &quot;dist{problem.scope}&quot;</Code>, or deploy as-is and fix it after.
        </Alert>
      );
    case "no-index":
      return null; // covered by the headline
  }
}

/** A compact, indented listing of the files that will ship. */
function FileTree({ paths }: { paths: string[] }) {
  const shown = paths.slice(0, 40);
  return (
    <Box
      style={{
        border: "1px solid var(--az-line)",
        borderRadius: "var(--mantine-radius-md)",
        background: "var(--mantine-color-dark-7)",
        padding: "8px 12px",
        maxHeight: 220,
        overflow: "auto",
      }}
    >
      <Stack gap={2}>
        {shown.map((p) => (
          <Group key={p} gap={6} wrap="nowrap">
            <Icon name="box" size={11} style={{ color: "var(--mantine-color-dark-3)" }} />
            <Text className="az-mono" fz={12} c="dark.1">
              {p}
            </Text>
          </Group>
        ))}
        {paths.length > shown.length && (
          <Text fz={11} c="dark.2" pl={17}>
            + {paths.length - shown.length} more
          </Text>
        )}
      </Stack>
    </Box>
  );
}
