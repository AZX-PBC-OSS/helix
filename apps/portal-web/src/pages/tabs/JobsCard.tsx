import { Button, Checkbox, Stack, Text } from "@mantine/core";
import { JOBS_FETCH_QUALIFIED_TYPE, type JobTypeCatalogueEntry } from "@azx-pbc/shared";
import { useCatalogue } from "../../lib/catalogue";
import { CapBlock, Hint, ToneBadge } from "../../components/primitives";

/**
 * The Background jobs card of the §6.3 capability editor (design.md
 * §§Information Architecture, Interaction States). Selection is the source for
 * the shared manifest preview and Save; removal rides the same save — there is
 * no second confirmation dialog. New selections come only from the
 * deployment's advertised types (`GET /api/v1/capabilities` `jobs.types`);
 * a saved type the deployment no longer offers stays visible and removable,
 * never newly selectable.
 */

/**
 * Per-type checkbox copy. The catalogue's wire entry is pinned to
 * `{id, displayName}` — no description field — so the presentation text lives
 * here, keyed by the qualified grant value; an advertised type absent from
 * this map renders its label and code with no description line.
 */
const TYPE_DESCRIPTIONS: Record<string, string> = {
  [JOBS_FETCH_QUALIFIED_TYPE]: "Fetch one JSON response using this app's fetch permissions.",
};

/** Design.md's guidance rows for the card, verbatim. */
const CAPACITY_GUIDANCE =
  "Platform limits protect submission rate, queue capacity and stored results. " +
  "Busy requests may need to be retried later.";
const FETCH_GUIDANCE =
  "Configure allowed origins in Fetch proxy above. Stored secrets and requests " +
  "without credentials are supported; delegated user connections are not. " +
  "Fetch requests retain their own limits.";
const IDENTITY_GUIDANCE =
  "Jobs require an authenticated user or a development token. Anonymous visitors " +
  "and shared-password sessions cannot use them.";
const EMPTY_SELECTION =
  "No job types selected. Saving this selection leaves no background jobs grant.";
const REMOVAL_WARNING =
  "Saving removes access to these job types, including status, results, and " +
  "cancellation. Already accepted jobs continue.";

export interface JobsCardProps {
  /** The saved manifest's job types — the removal warning reads the difference. */
  readonly savedTypes: readonly string[];
  /** The draft's selected types. */
  readonly selectedTypes: readonly string[];
  /** Replace the draft's selection (whole-array, like every other block). */
  readonly onTypesChange: (types: string[]) => void;
}

export function JobsCard({ savedTypes, selectedTypes, onTypesChange }: JobsCardProps) {
  const { catalogue, failed, loading, retry } = useCatalogue();

  const selected = new Set(selectedTypes);
  const advertised: JobTypeCatalogueEntry[] = catalogue?.jobs?.types ?? [];
  // Draft-held types the loaded catalogue does not advertise: still visible and
  // removable, never newly selectable. With the catalogue absent (still
  // loading, or failed) a held type cannot be classified — it renders plainly
  // rather than flashing a false "withdrawn" flag, the same posture the model
  // picker takes. Either way the rows render: a failed discovery must not read
  // as an empty grant.
  //
  // Deduped because the rows are a set-semantics grant rendered from a
  // non-normalized array: the manifest parse pins min(1), not uniqueness —
  // deliberately syntax-only, so a hand-authored manifest can carry the same
  // qualified id twice and toDraft copies it verbatim. One row per distinct
  // type; unchecking filters by value and removes every copy. The advertised
  // side cannot duplicate — the deployment schema refuses an installed type
  // list that is not a set.
  const heldUnadvertised = [
    ...new Set(selectedTypes.filter((t) => !advertised.some((a) => a.id === t))),
  ];
  const removingSaved = savedTypes.some((t) => !selected.has(t));

  const toggle = (id: string, on: boolean) =>
    onTypesChange(on ? [...selectedTypes, id] : selectedTypes.filter((t) => t !== id));

  return (
    <CapBlock
      icon="clock"
      title="Background jobs"
      desc="Run platform-provided work in the background. Jobs accept inputs, not app code."
    >
      <Stack gap={12}>
        {!failed &&
          advertised.map((entry) => (
            <Checkbox
              key={entry.id}
              checked={selected.has(entry.id)}
              onChange={(e) => toggle(entry.id, e.currentTarget.checked)}
              label={
                <Text span>
                  {entry.displayName}{" "}
                  <Text span className="az-mono" fz={11} c="dark.2">
                    {entry.id}
                  </Text>
                </Text>
              }
              description={TYPE_DESCRIPTIONS[entry.id]}
            />
          ))}
        {heldUnadvertised.map((id) => (
          <Checkbox
            key={id}
            checked
            onChange={() => toggle(id, false)}
            label={
              <Text span className="az-mono">
                {id}
              </Text>
            }
            description={
              catalogue === null ? undefined : (
                <ToneBadge tone="warn" icon="alert">
                  not offered on this deployment
                </ToneBadge>
              )
            }
          />
        ))}
        {failed ? (
          <Hint
            icon="alert"
            tone="bad"
            action={
              <Button size="xs" variant="default" onClick={retry}>
                Retry
              </Button>
            }
          >
            Couldn&apos;t load the job type catalogue. Your selections are untouched — retry to list
            the types this deployment offers.
          </Hint>
        ) : (
          catalogue === null && (
            <Text size="xs" c="dark.2">
              {loading
                ? "Loading the job type catalogue…"
                : "The job type catalogue has not loaded."}
            </Text>
          )
        )}

        {removingSaved && (
          <Hint icon="alert" tone="warn">
            {REMOVAL_WARNING}
          </Hint>
        )}
        {selectedTypes.length === 0 && (
          <Text size="xs" c="dark.2">
            {EMPTY_SELECTION}
          </Text>
        )}
        {selected.has(JOBS_FETCH_QUALIFIED_TYPE) && (
          <Text size="xs" c="dark.2" lh={1.45}>
            {FETCH_GUIDANCE}
          </Text>
        )}
        <Text size="xs" c="dark.2" lh={1.45}>
          {CAPACITY_GUIDANCE}
        </Text>
        <Text size="xs" c="dark.2" lh={1.45}>
          {IDENTITY_GUIDANCE}
        </Text>
      </Stack>
    </CapBlock>
  );
}
