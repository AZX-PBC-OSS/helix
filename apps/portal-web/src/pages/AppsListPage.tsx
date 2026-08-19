import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import {
  Box,
  Button,
  Card,
  Center,
  Code,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { AppListScopeSchema, type AppListScope } from "@azx-pbc/shared";
import { appsQuery } from "../api/queries";
import { AppsTable } from "../components/AppsTable";
import { Icon } from "../components/Icon";
import { CopyBtn, Eyebrow, Hint, PageHead } from "../components/primitives";
import { useDeployment } from "../lib/deployment";
import { appStatus } from "../lib/appStatus";
import { useDeploy } from "../modals/DeployContext";
import { useHelp } from "../modals/HelpContext";
import { useRenderedSkill } from "../lib/skill";

/**
 * Hand the agent the instructions, from the screen it starts on.
 *
 * Unconditional, and it replaced four stat cards counting apps by state. Those
 * were a dashboard for a workspace that mostly has three apps in it, and at zero
 * apps they were four zeroes greeting a first-time user. This is the trade: the
 * skill is the highest-value thing the portal hands out, it was one click deep
 * behind the sidebar's **How to develop**, and it is not first-run content —
 * you re-copy it whenever you start an app or a fresh agent session, which is
 * exactly when you are standing here.
 *
 * The pitch is a one-line version of the modal's own callout
 * (`modals/HelpModal.tsx`); keep the two saying the same thing. Creating an app
 * deliberately isn't here — the page header owns that, a few pixels up.
 */
function AgentHandoff() {
  const { openHelp } = useHelp();
  const skill = useRenderedSkill();

  return (
    <Card
      mb={24}
      p="14px 18px"
      style={{
        border: "1px solid var(--az-line-2)",
        background: "color-mix(in srgb, var(--az-acc) 6%, transparent)",
      }}
    >
      <Group justify="space-between" align="center" gap={16} wrap="wrap">
        <Box style={{ minWidth: 260, flex: 1 }}>
          <Eyebrow mb={4}>Building with an AI agent?</Eyebrow>
          <Text size="sm" c="dark.2" lh={1.5}>
            Hand it this deployment&apos;s instructions — the capability manifest, the{" "}
            <Code>/_api/*</Code> gateway, the CSP to build within, and the deploy flow, with real
            hostnames already filled in.
          </Text>
        </Box>
        <Group gap={8} wrap="nowrap">
          {/* Cyan, not the primary orange: the page header's Create app sits a few
              pixels above, and two filled CTAs in the same hue read as one choice
              made twice. Handing over the skill is the accent family's job — the
              same hue this card is tinted with. */}
          {/* Disabled, never a half-rendered skill, until GET /api/v1/config lands. */}
          {skill ? (
            <CopyBtn
              value={skill}
              label="Copy agent instructions"
              size="sm"
              variant="filled"
              color="accent"
            />
          ) : (
            <Button size="sm" disabled leftSection={<Icon name="copy" size={13} />}>
              Copy agent instructions
            </Button>
          )}
          <Button
            variant="default"
            size="sm"
            leftSection={<Icon name="book" size={14} />}
            onClick={openHelp}
          >
            How to develop
          </Button>
        </Group>
      </Group>
    </Card>
  );
}

type Filter = "all" | "live" | "notlive" | "archived";

/**
 * The apps list — the workspace's landing screen and the only presentation of
 * the registry.
 *
 * There used to be two: a card grid here and a dense table on `/admin/registry`,
 * both rendering `GET /api/v1/apps`, which returned every app to either one. Two
 * names for one query, with the different layouts hiding it. The scope control
 * below is that distinction made real — and it is a **filter, not a gate**: any
 * signed-in principal may browse a colleague's apps, because a deployment serves
 * one trusted org (ADR-0028). `/admin/registry` now redirects here at
 * `?scope=all`.
 */
export function AppsListPage() {
  const [params, setParams] = useSearchParams();
  // Scope lives in the URL so it survives a reload, can be linked, and gives the
  // old admin route somewhere to land.
  const scope: AppListScope = AppListScopeSchema.catch("mine").parse(params.get("scope") ?? "mine");
  const apps = useQuery(appsQuery(scope));
  const { appHost, appUrl } = useDeployment();
  const { openCreate } = useDeploy();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const setScope = (next: string) => {
    const p = new URLSearchParams(params);
    // `mine` is the default, so keep it out of the URL rather than pinning it.
    if (next === "mine") p.delete("scope");
    else p.set("scope", next);
    setParams(p, { replace: true });
  };

  const list = useMemo(() => apps.data ?? [], [apps.data]);
  // Counts and the status column now agree: both read `appStatus`, which needs the
  // list endpoint's projected preview number to tell "nothing deployed" from "a
  // build is waiting". "Not live" covers both, which is what this ever counted.
  const counts = useMemo(
    () => ({
      all: list.length,
      live: list.filter((a) => appStatus(a) === "live").length,
      notlive: list.filter((a) => ["preview", "empty"].includes(appStatus(a))).length,
      archived: list.filter((a) => appStatus(a) === "archived").length,
    }),
    [list],
  );

  const shown = list.filter((a) => {
    const status = appStatus(a);
    if (filter === "live" && status !== "live") return false;
    if (filter === "notlive" && !["preview", "empty"].includes(status)) return false;
    if (filter === "archived" && status !== "archived") return false;
    if (search && !(a.displayName + a.slug).toLowerCase().includes(search.toLowerCase()))
      return false;
    return true;
  });

  return (
    <div>
      <PageHead
        // The apps domain arrives with the deployment config; until it does, the
        // eyebrow is just "Workspace" rather than a guessed host.
        eyebrow={["Workspace", appHost("<slug>")].filter(Boolean).join(" · ")}
        title="Apps"
        sub={
          scope === "mine"
            ? "Static apps you've deployed."
            : "Every app registered on this deployment."
        }
        actions={
          // The one creation surface in the SPA, and deliberately unconditional:
          // registration used to hide inside the deploy modal's app picker, so a
          // single registered app cut off the path to a second. Deploying moved
          // to the app's own page, where it has a target.
          <Button size="md" leftSection={<Icon name="plus" size={15} />} onClick={openCreate}>
            Create app
          </Button>
        }
      />

      <AgentHandoff />

      <Group mb={18} gap={10}>
        <SegmentedControl
          value={scope}
          onChange={setScope}
          data={[
            { value: "mine", label: "Mine" },
            { value: "all", label: "All" },
          ]}
        />
        <SegmentedControl
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          data={[
            { value: "all", label: `All ${counts.all}` },
            { value: "live", label: `Live ${counts.live}` },
            { value: "notlive", label: `Not live ${counts.notlive}` },
            { value: "archived", label: `Archived ${counts.archived}` },
          ]}
        />
        <TextInput
          placeholder="Search apps…"
          leftSection={<Icon name="search" size={14} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          style={{ flex: 1, maxWidth: 280 }}
        />
      </Group>

      {apps.isPending && (
        <Center py={80}>
          <Loader />
        </Center>
      )}
      {apps.isError && (
        <Hint tone="bad" icon="alert">
          Couldn&apos;t reach the portal API: {apps.error.message}
        </Hint>
      )}
      {apps.isSuccess && shown.length === 0 && (
        <Card py={56} style={{ textAlign: "center" }}>
          <Stack align="center" gap={6}>
            <Text ff="heading" fw={600} fz={17}>
              {list.length > 0
                ? "Nothing matches"
                : scope === "mine"
                  ? "No apps yet"
                  : "Nothing registered yet"}
            </Text>
            <Text c="dark.2" size="sm" maw={420}>
              {list.length > 0 ? (
                "Try a different filter or search."
              ) : (
                <>
                  Register one here or from the CLI, then ship a build into it.
                  {/* Drop the "served at" clause entirely until the deployment
                      config lands — a half-rendered URL is worse than none. */}
                  {appUrl("<slug>") && (
                    <>
                      {" "}
                      It will be served at{" "}
                      <Text component="span" className="az-mono" fz={12}>
                        {appUrl("<slug>")}
                      </Text>
                      .
                    </>
                  )}
                </>
              )}
            </Text>
            {list.length === 0 && (
              <Button
                mt={12}
                size="md"
                leftSection={<Icon name="plus" size={15} />}
                onClick={openCreate}
              >
                Create your first app
              </Button>
            )}
          </Stack>
        </Card>
      )}

      {apps.isSuccess && shown.length > 0 && <AppsTable rows={shown} />}
    </div>
  );
}
