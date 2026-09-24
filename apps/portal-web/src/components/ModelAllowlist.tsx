import { useState, type CSSProperties } from "react";
import { Box, Button, Group, NumberInput, Table, Text, TextInput } from "@mantine/core";
import { MODEL_PRICING, priceForModel } from "@azx-pbc/shared";
import { useCatalogue } from "../lib/catalogue";
import { fmtCount } from "../lib/format";
import { Icon } from "./Icon";
import { ToneBadge } from "./primitives";

/**
 * Offer models from the deployment's /api/v1/capabilities catalogue
 * (ADR-0036/0047); use bundled pricing for rates and daily-budget estimates.
 * Keep estimate cells present with — until a budget is set to avoid layout shifts.
 *
 * Preserve saved off-list models: flag withheld models and allow removal.
 * Unknown custom models remain editable but are unpriced, require approval,
 * and are refused by the edge.
 */

/** The vertical rule splitting the static (catalogue) and dynamic (budget) halves. */
const DIVIDER: CSSProperties = { borderLeft: "1px solid var(--az-line)" };
const NUM_W = 92;

/** Per-Mtok rate as "$5" / "$3.5" — catalogue values are small, keep it terse. */
function rate(n: number): string {
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

/** Tokens a daily budget buys at a per-Mtok rate, or "—" when no cap is set. */
function tokensPerDay(dollarsPerDay: number | undefined, perMTok: number): string {
  if (dollarsPerDay === undefined || !(dollarsPerDay > 0)) return "—";
  return fmtCount(Math.floor((dollarsPerDay * 1_000_000) / perMTok));
}

export function ModelAllowlist({
  models,
  dollarsPerDay,
  onModelsChange,
  onCapChange,
}: {
  models: string[];
  dollarsPerDay: number | undefined;
  onModelsChange: (models: string[]) => void;
  onCapChange: (dollarsPerDay: number | undefined) => void;
}) {
  const [custom, setCustom] = useState("");
  const { catalogue, failed } = useCatalogue();
  const selected = new Set(models);
  // The three row classes partition the grant: advertised here, catalogued but
  // withheld here, and off-catalogue entirely. Until the catalogue lands (or
  // if it fails) nothing is classified — the loading/failed note stands in, so
  // a granted model never flashes a false "withheld" flag.
  const available = catalogue?.llm.models ?? [];
  const withheldModels =
    catalogue === null ? [] : models.filter((m) => m in MODEL_PRICING && !available.includes(m));
  const customModels = models.filter((m) => !(m in MODEL_PRICING));
  const capDisabled = models.length === 0;

  const toggle = (id: string, on: boolean) =>
    onModelsChange(on ? [...models, id] : models.filter((m) => m !== id));

  const addCustom = () => {
    const id = custom.trim();
    if (id && !selected.has(id)) onModelsChange([...models, id]);
    setCustom("");
  };

  return (
    <Box>
      <Table fz={12.5} verticalSpacing={6} layout="fixed">
        <colgroup>
          <col style={{ width: 36 }} />
          <col />
          <col style={{ width: NUM_W }} />
          <col style={{ width: NUM_W }} />
          <col style={{ width: NUM_W }} />
          <col style={{ width: NUM_W }} />
        </colgroup>
        <Table.Thead>
          {/* Group row: a spacer over the static half, the cap control over the dynamic half. */}
          <Table.Tr>
            <Table.Th colSpan={4} style={{ borderBottom: "none" }} />
            <Table.Th colSpan={2} style={{ ...DIVIDER, borderBottom: "none" }}>
              <Group gap={7} wrap="nowrap" align="center">
                <Text fz={11} c="dark.2" tt="uppercase" style={{ letterSpacing: ".04em" }}>
                  budget
                </Text>
                <NumberInput
                  value={dollarsPerDay ?? ""}
                  onChange={(v) => {
                    const n = typeof v === "number" ? v : Number(v);
                    onCapChange(v === "" || !Number.isFinite(n) ? undefined : n);
                  }}
                  disabled={capDisabled}
                  min={0.01}
                  step={1}
                  decimalScale={2}
                  prefix="$"
                  placeholder="10"
                  size="xs"
                  w={104}
                  classNames={{ input: "az-mono" }}
                />
                <Text fz={11} c="dark.2">
                  / day
                </Text>
              </Group>
            </Table.Th>
          </Table.Tr>
          {/* Column row. */}
          <Table.Tr className="az-mono">
            <Table.Th />
            <Table.Th>model</Table.Th>
            <Table.Th ta="right">input $/Mtok</Table.Th>
            <Table.Th ta="right">output $/Mtok</Table.Th>
            <Table.Th ta="right" style={DIVIDER}>
              input tok/day
            </Table.Th>
            <Table.Th ta="right">output tok/day</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody className="az-mono">
          {catalogue === null && (
            <Table.Tr>
              <Table.Td colSpan={6}>
                <Text fz={12} c={failed ? "yellow.6" : "dark.2"}>
                  {failed
                    ? "This deployment's model catalogue didn't load — reload to retry. Granted models still apply; they just can't be edited here."
                    : "Loading this deployment's model catalogue…"}
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
          {available.map((id) => {
            const price = priceForModel(id)!;
            const on = selected.has(id);
            return (
              <Table.Tr
                key={id}
                onClick={() => toggle(id, !on)}
                style={{ cursor: "pointer" }}
                data-selected={on || undefined}
              >
                <Table.Td>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => toggle(id, e.currentTarget.checked)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={id}
                  />
                </Table.Td>
                <Table.Td style={{ whiteSpace: "nowrap" }}>{id}</Table.Td>
                <Table.Td ta="right">{rate(price.inputPerMTok)}</Table.Td>
                <Table.Td ta="right">{rate(price.outputPerMTok)}</Table.Td>
                <Table.Td ta="right" style={DIVIDER} c={on ? undefined : "dark.3"}>
                  {tokensPerDay(dollarsPerDay, price.inputPerMTok)}
                </Table.Td>
                <Table.Td ta="right" c={on ? undefined : "dark.3"}>
                  {tokensPerDay(dollarsPerDay, price.outputPerMTok)}
                </Table.Td>
              </Table.Tr>
            );
          })}
          {withheldModels.map((id) => (
            <Table.Tr key={id} data-selected>
              <Table.Td>
                <input type="checkbox" checked onChange={() => toggle(id, false)} aria-label={id} />
              </Table.Td>
              <Table.Td style={{ whiteSpace: "nowrap" }}>{id}</Table.Td>
              <Table.Td colSpan={2} ta="right">
                <ToneBadge tone="warn" icon="alert">
                  withheld on this deployment
                </ToneBadge>
              </Table.Td>
              <Table.Td colSpan={2} ta="right" style={DIVIDER} c="dark.3">
                calls fail while it stays granted
              </Table.Td>
            </Table.Tr>
          ))}
          {customModels.map((id) => (
            <Table.Tr key={id} data-selected>
              <Table.Td>
                <input type="checkbox" checked onChange={() => toggle(id, false)} aria-label={id} />
              </Table.Td>
              <Table.Td style={{ whiteSpace: "nowrap" }}>{id}</Table.Td>
              <Table.Td colSpan={2} ta="right">
                <ToneBadge tone="warn" icon="alert">
                  custom — unpriced
                </ToneBadge>
              </Table.Td>
              <Table.Td colSpan={2} ta="right" style={DIVIDER} c="dark.3">
                needs admin approval
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Group gap={8} mt={12} align="flex-end">
        <TextInput
          label="Add a custom model"
          description="Off-catalogue ids are unpriced (the gateway refuses them) and need admin approval. A catalogued id this deployment withholds shows flagged above and fails at call time."
          placeholder="model id"
          value={custom}
          onChange={(e) => setCustom(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
          style={{ flex: 1 }}
          size="xs"
          classNames={{ input: "az-mono" }}
        />
        <Button
          variant="default"
          size="xs"
          leftSection={<Icon name="plus" size={12} />}
          onClick={addCustom}
          disabled={custom.trim() === "" || selected.has(custom.trim())}
        >
          Add
        </Button>
      </Group>
      {models.length === 0 && (
        <Text size="xs" c="dark.2" mt={8}>
          No models selected — this app can't call the LLM gateway.
        </Text>
      )}
    </Box>
  );
}
