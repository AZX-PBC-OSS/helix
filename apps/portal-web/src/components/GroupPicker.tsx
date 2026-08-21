import { useMemo, useState } from "react";
import { Button, Group, MultiSelect, Stack, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { MAX_VISIBILITY_GROUPS, type DirectoryGroup } from "@azx-pbc/shared";
import { appVisibilityGroupsQuery, directoryGroupsQuery, myGroupsQuery } from "../api/queries";
import { Hint } from "./primitives";

/**
 * Pick the directory groups that may open an app (ADR-0040 §5, §8, §9).
 *
 * Three behaviours are load-bearing rather than decorative:
 *
 * 1. **It defaults to the caller's own groups.** Most apps are scoped to a team
 *    the owner is in, so the common case needs no search at all. Those come from
 *    the groups claim on the token the portal already verified — not Graph — so
 *    they answer even where the directory grant is missing (§6).
 *
 * 2. **Selected ids that don't resolve still render.** `MultiSelect` shows a
 *    value verbatim when it isn't in `data`, which is exactly the
 *    "unknown group (<id>)" degradation §7 asks for — so we lean on it
 *    deliberately, and seed `data` with an explicit label for those ids rather
 *    than letting a bare GUID appear as if it were a name.
 *
 * 3. **It survives an unavailable directory.** When the tenant hasn't granted
 *    `GroupMember.Read.All` there is no picker to show, so it becomes a plain
 *    id entry field with a banner naming the permission (§8). Group visibility
 *    keeps working end to end regardless — enforcement never depended on Graph.
 */
export function GroupPicker({
  value,
  onChange,
  disabled,
  slug,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  /**
   * The app whose stored groups need naming. Omitted at create time, where there
   * is no app yet and the selection starts empty.
   */
  slug?: string;
}) {
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState("");
  /**
   * The endpoint refuses a term under three characters (no bare-prefix directory
   * dumps) and rate-limits per actor, so firing per keystroke would spend that
   * budget on guaranteed 400s. Debounce, then gate on length.
   */
  const [debounced] = useDebouncedValue(search.trim(), 250);
  const canSearch = debounced.length >= 3;

  const mine = useQuery(myGroupsQuery);
  const found = useQuery({ ...directoryGroupsQuery(debounced), enabled: canSearch });
  /**
   * Names for the groups the app is *already* scoped to. Without this every
   * stored group renders as `unknown group (<id>)` — the documented degradation,
   * shown wrongly, since the directory can name them perfectly well. The owner
   * would see it on the one screen where they most need to know what they picked.
   */
  const stored = useQuery({ ...appVisibilityGroupsQuery(slug ?? ""), enabled: Boolean(slug) });

  /**
   * Unavailability is reported by whichever query actually needed the directory.
   * Search is the one that does — `my-groups` answers off the token claim — so a
   * missing grant shows up there first, and only once the operator searches. Read
   * both so the banner appears either way.
   */
  const unavailable =
    (found.data && !found.data.available && found.data) ||
    (mine.data && !mine.data.available && mine.data) ||
    null;

  /**
   * The option list the control renders from: search hits, the caller's groups,
   * and — critically — a placeholder for every already-selected id we could not
   * name. Without that last group a stored id would render as a bare GUID that
   * looks like a name, and an operator could not tell "Engineering" from a group
   * that was deleted last month.
   */
  const data = useMemo(() => {
    // Derived inside the memo, not above it: `x.data?.available ? x.data.groups : []`
    // allocates a fresh array on every render, so as a dependency it would defeat
    // the memo entirely.
    const mineGroups = mine.data?.available ? mine.data.groups : [];
    const foundGroups = found.data?.available ? found.data.groups : [];
    const storedGroups = stored.data?.available ? stored.data.groups : [];
    const byId = new Map<string, DirectoryGroup>();
    for (const g of [...storedGroups, ...mineGroups, ...foundGroups]) {
      // Merge so a *known* security flag survives an entry that doesn't carry
      // one. Both endpoints can return the same group, and only search is
      // guaranteed to report the flag — a blind overwrite would make a group's
      // eligibility depend on which query resolved last.
      const prev = byId.get(g.id);
      byId.set(g.id, {
        ...g,
        securityEnabled: g.securityEnabled ?? prev?.securityEnabled,
      });
    }
    const options = [...byId.values()].map((g) => ({
      value: g.id,
      // `undefined` means nobody told us, which is not the same as `false` — so
      // only an explicit `false` earns the label and the lockout.
      label:
        g.securityEnabled === false ? `${g.displayName} — not a security group` : g.displayName,
      disabled: g.securityEnabled === false && !value.includes(g.id),
    }));
    const unresolved = value.filter((id) => !byId.has(id));
    return [
      ...options,
      ...unresolved.map((id) => ({ value: id, label: `unknown group (${id})`, disabled: false })),
    ];
  }, [mine.data, found.data, stored.data, value]);

  const atCap = value.length >= MAX_VISIBILITY_GROUPS;

  const addManual = () => {
    const id = manual.trim();
    // Silently ignoring a duplicate beats an error: re-adding a group already in
    // the list is a no-op the operator meant, not a mistake worth a message.
    if (id.length > 0 && !atCap && !value.includes(id)) onChange([...value, id]);
    setManual("");
  };

  return (
    <Stack gap={8}>
      {unavailable && (
        <Hint tone="slate" icon="alert">
          Group search is unavailable on this deployment, so group ids have to be entered directly.{" "}
          {/*
           * Worded per reason, because each one is a different person's job: a
           * missing grant needs a directory administrator, a missing token needs
           * whoever configured this portal. Telling someone to ask an admin for a
           * permission when the portal simply cannot authenticate sends them to
           * the wrong place, so `missingPermission` alone is not the condition.
           */}
          {unavailable.reason === "no-consent" && unavailable.missingPermission
            ? `An administrator can enable it by granting the portal's identity the ${unavailable.missingPermission} permission in Microsoft Entra.`
            : unavailable.detail}{" "}
          Access control itself is unaffected — the ids below are still enforced at sign-in.
        </Hint>
      )}
      <MultiSelect
        label="Directory groups"
        // One description, not one per state: the control is hidden outright when
        // there is nothing to search, so an unavailable-specific string here would
        // be dead copy that only ever showed up as a duplicate of the banner.
        description="Search your directory, or pick from the groups you're in. Anyone in any of these groups can open the app."
        placeholder={value.length === 0 ? "search for a group" : undefined}
        data={data}
        value={value}
        onChange={onChange}
        searchable
        searchValue={search}
        onSearchChange={setSearch}
        nothingFoundMessage={
          canSearch
            ? found.isFetching
              ? "Searching…"
              : "No matching groups — you can still add an id below."
            : "Type at least 3 characters to search."
        }
        maxValues={MAX_VISIBILITY_GROUPS}
        // Hidden rather than merely empty when there is no directory to search:
        // a search box that can never return anything is worse than no search box,
        // because it reads as "no such group" instead of "we cannot look".
        display={unavailable ? "none" : undefined}
        disabled={disabled}
      />
      {/*
       * The escape hatch, and not only for the degraded path. A group can exist
       * that search cannot reach — no grant, an eventual-consistency lag on a
       * freshly created group, a name nobody would guess — and refusing a pasted
       * id would make this picker a downgrade from the plain text box it replaces.
       * Same shape as `ModelAllowlist`'s off-catalogue entry.
       */}
      <Group gap={8} align="flex-end" wrap="nowrap">
        <TextInput
          label={unavailable ? "Group id" : "Add by id"}
          description={
            unavailable ? "Paste the group's object id from Microsoft Entra." : undefined
          }
          placeholder="e.g. eng-team or an Entra group GUID"
          value={manual}
          onChange={(e) => setManual(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addManual();
            }
          }}
          size="xs"
          style={{ flex: 1 }}
          disabled={disabled || atCap}
          classNames={{ input: "az-mono" }}
        />
        <Button
          size="xs"
          variant="default"
          onClick={addManual}
          disabled={disabled || atCap || manual.trim().length === 0}
        >
          Add
        </Button>
      </Group>
      {atCap && (
        <Text size="xs" c="dark.2">
          That&apos;s the maximum of {MAX_VISIBILITY_GROUPS} groups. Remove one to add another.
        </Text>
      )}
    </Stack>
  );
}
