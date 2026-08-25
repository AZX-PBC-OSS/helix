import { useMemo, useState } from "react";
import { Button, Group, MultiSelect, Stack, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { MAX_VISIBILITY_GROUPS, type DirectoryGroup } from "@azx-pbc/shared";
import { appVisibilityGroupsQuery, directoryGroupsQuery, myGroupsQuery } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
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
 * 3. **Three states, not two — and the third is "we don't know".** Search may be
 *    allowed, refused, or unanswered (`/api/v1/me` errored). Unanswered renders
 *    no search box *and no explanation*, because every sentence available for
 *    that state would be a guess about deployment policy.
 *
 * 4. **A caller who may not search is not a caller with a broken directory.**
 *    `PORTAL_DIRECTORY_SEARCH` (ADR-0040 decision 11) can restrict search to
 *    platform admins, or to nobody. That state is kept strictly apart from
 *    `unavailable`: the two id→name resolves are never gated, so a restricted
 *    caller still sees their own groups *by name* and their app's stored groups
 *    *by name* — only discovery goes. Rendering it through the unavailable banner
 *    would tell them the directory is down while it is visibly naming groups for
 *    them, and would push them to the free-text id box they do not need.
 *
 * 5. **It survives an unavailable directory, and stays fully editable.** When the
 *    tenant hasn't granted `GroupMember.Read.All` the search goes away but the
 *    selection and its remove buttons do not, and a banner names the permission
 *    (§8). Removal has to keep working precisely here: this is the state where an
 *    owner cannot re-find a group they just took off. Group visibility keeps
 *    working end to end regardless — enforcement never depended on Graph.
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
   * Server-computed from this deployment's tier and the caller's admin-ness, so
   * the browser never learns the tier or the admin group id. Asked up front
   * rather than by firing a search and reading the 403: the request would be
   * refused every time, and an errored query is exactly the shape
   * `nothingFoundMessage` has to translate into "search failed" — which this is
   * not.
   */
  const { canSearchDirectory, searchRestriction } = useAuth();
  /**
   * Two booleans from a tri-state, not one negation of a boolean. `undefined`
   * means `/api/v1/me` has not answered — in flight, or errored, which is
   * reachable on a single 500 because `meQuery` does not retry and `meLoading`
   * only covers the in-flight half. Both derived values are then false, so an
   * unknown state offers no search box and, critically, **makes no claim about
   * why**. `!canSearchDirectory` collapsed "refused" and "don't know" into the
   * same branch and rendered a deployment-policy sentence for both.
   */
  const searchAllowed = canSearchDirectory === true;
  const searchRefused = canSearchDirectory === false;
  /**
   * The endpoint refuses a term under three characters (no bare-prefix directory
   * dumps) and rate-limits per actor, so firing per keystroke would spend that
   * budget on guaranteed 400s. Debounce, then gate on length.
   */
  const [debounced] = useDebouncedValue(search.trim(), 250);
  const canSearch = debounced.length >= 3;

  const mine = useQuery(myGroupsQuery);
  const found = useQuery({
    ...directoryGroupsQuery(debounced),
    enabled: canSearch && searchAllowed,
  });
  /**
   * Names for the groups the app is *already* scoped to. Without this every
   * stored group renders as `unknown group (<id>)` — the documented degradation,
   * shown wrongly, since the directory can name them perfectly well. The owner
   * would see it on the one screen where they most need to know what they picked.
   */
  const stored = useQuery({ ...appVisibilityGroupsQuery(slug ?? ""), enabled: Boolean(slug) });

  /**
   * Unavailability is reported by whichever query actually needed the directory,
   * and **all three of them do** — an earlier version of this read only `found`
   * and `mine` on the reasoning that "`my-groups` answers off the token claim".
   * That is true of where the *ids* come from and false of what happens next:
   * `my-groups` still resolves them through Graph. Worse, when the caller has no
   * group claims at all it short-circuits to an empty list without touching
   * Graph, so it can never report an outage — and for a group-scoped app opened
   * by such a caller who has not searched yet, `stored` was the only query that
   * knew, and its answer was thrown away. No banner, on a tenant where search
   * cannot work.
   *
   * `stored` first because it is the most specific signal: it fires on open,
   * without waiting for the operator to type.
   */
  const unavailable =
    (stored.data && !stored.data.available && stored.data) ||
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
    // Gated on `searchAllowed` as well as on the payload: if `me` refetches
    // mid-session and flips this caller to refused, the last search's results are
    // still sitting in the query cache under their own key, and merging them would
    // leave the option list showing groups this caller can no longer discover.
    const foundGroups = searchAllowed && found.data?.available ? found.data.groups : [];
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
  }, [mine.data, found.data, stored.data, value, searchAllowed]);

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
      {/*
       * Only when the directory is otherwise fine. If it is unavailable that
       * banner is the more useful thing to say, and stacking both would offer two
       * competing explanations for one missing search box.
       *
       * Deliberately NOT worded as a failure. Everything else on this control
       * still works — the groups below are named, the selection is editable — so
       * "unavailable" would be false, and would send someone to ask an
       * administrator about a Graph permission that is granted and working.
       */}
      {searchRefused && !unavailable && (
        <Hint tone="slate" icon="info">
          {/*
           * Worded from the reason, not from a guess. The first version hard-coded
           * "limited to platform admins", which is false under the `none` tier —
           * and false in the worst direction, because a platform admin refused by
           * `none` was told the restriction was the very role they hold, sending
           * them to audit a PORTAL_ADMIN_GROUP_ID that is perfectly correct.
           * `searchRestriction` is absent on older portals, so the last branch is
           * a real fallback rather than a formality.
           */}
          {searchRestriction === "admins"
            ? "Searching all directory groups is limited to platform admins on this deployment — ask one if you need a group you can't find here."
            : searchRestriction === "none"
              ? "Searching all directory groups is turned off on this deployment, for everyone."
              : "Searching all directory groups is restricted on this deployment."}{" "}
          You can still pick from the groups you&apos;re in, or add any group by its id.
        </Hint>
      )}
      {/*
       * ALWAYS MOUNTED, even with no directory to search. An earlier version set
       * `display: none` here when unavailable, reasoning that a search box which
       * can never return anything reads as "no such group" rather than "we cannot
       * look". That was true and beside the point: `display` is a style prop on
       * the MultiSelect *root*, so it hid the whole wrapper — the pills showing
       * the current selection and every pill's remove button with them. Since
       * `addManual` only ever appends, an owner on a tenant that never granted the
       * Graph permission could add group ids but neither see the selection nor
       * remove one; at the cap, with the id field disabled, there was no editable
       * control left at all. The only way to narrow such an app was switching to
       * Internal and back — briefly widening it to the entire directory, which is
       * the exact hazard the Access tab's `editable` branch exists to prevent.
       *
       * So the control stays; only `searchable` goes. `searchValue`/`onSearchChange`
       * are omitted with it, because a controlled search value on a non-searchable
       * MultiSelect is a Mantine warning.
       */}
      <MultiSelect
        label="Directory groups"
        description={
          unavailable
            ? "Remove a group with its ×. New ones have to be added by id below."
            : !searchAllowed
              ? "Pick from the groups you're in, or add any group by id below. Anyone in any of these groups can open the app."
              : "Search your directory, or pick from the groups you're in. Anyone in any of these groups can open the app."
        }
        placeholder={
          value.length === 0
            ? unavailable
              ? "none selected"
              : !searchAllowed
                ? "pick from your groups"
                : "search for a group"
            : undefined
        }
        data={data}
        value={value}
        onChange={onChange}
        searchable={!unavailable && searchAllowed}
        {...(unavailable || !searchAllowed
          ? {}
          : { searchValue: search, onSearchChange: setSearch })}
        nothingFoundMessage={
          // A failed search must not read as an empty one. `DirectoryError` from a
          // throttled or broken Graph surfaces as a query error, not as an
          // `available: false` outcome, so without this branch a rate-limited
          // directory told every operator "no matching groups" — i.e. "that group
          // does not exist".
          found.isError
            ? "Search failed — the directory did not answer. Try again, or add the id below."
            : !searchAllowed
              ? // Reached when the caller is in no groups and the app has none stored,
                // so there is nothing to list. Never mentions searching: this caller
                // cannot, and telling them to type would be a dead end.
                "No groups to pick from — add one by id below."
              : canSearch
                ? found.isFetching
                  ? "Searching…"
                  : "No matching groups — you can still add an id below."
                : "Type at least 3 characters to search."
        }
        maxValues={MAX_VISIBILITY_GROUPS}
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
          /* Stays enabled in every state. What the tier controls is discovering
             group *names*, not using a group *id* — so removing this would leave a
             restricted caller unable to scope an app to any group they are not
             personally in, which no posture asks for. */
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
