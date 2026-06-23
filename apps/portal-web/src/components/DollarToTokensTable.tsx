import { Table } from "@mantine/core";
import { priceForModel } from "@helix/shared";
import { fmtCount } from "../lib/format";
import { ToneBadge } from "./primitives";

/**
 * "What does $X/day actually buy?" — a small helper beside the USD budget input.
 * A dollar cap maps to a different token count per model (and input vs. output
 * tokens are priced differently), so we show the range per allowlisted model at
 * current catalog rates. Purely informational; the edge enforces the dollars.
 */
export function DollarToTokensTable({
  models,
  dollarsPerDay,
}: {
  models: string[];
  dollarsPerDay: number;
}) {
  if (!models.length || !(dollarsPerDay > 0)) return null;

  const rows = models.map((model) => {
    const price = priceForModel(model);
    return { model, price };
  });

  return (
    <Table fz={12} verticalSpacing={4} className="az-mono" mt={4}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>model</Table.Th>
          <Table.Th ta="right">input tok/day</Table.Th>
          <Table.Th ta="right">output tok/day</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map(({ model, price }) => (
          <Table.Tr key={model}>
            <Table.Td>{model}</Table.Td>
            {price ? (
              <>
                <Table.Td ta="right">
                  {fmtCount(Math.floor((dollarsPerDay * 1_000_000) / price.inputPerMTok))}
                </Table.Td>
                <Table.Td ta="right">
                  {fmtCount(Math.floor((dollarsPerDay * 1_000_000) / price.outputPerMTok))}
                </Table.Td>
              </>
            ) : (
              <Table.Td colSpan={2} ta="right">
                <ToneBadge tone="warn" icon="alert">
                  unpriced — calls refused
                </ToneBadge>
              </Table.Td>
            )}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
