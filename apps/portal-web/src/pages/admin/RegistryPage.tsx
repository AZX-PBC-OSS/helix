import { useState } from "react";
import { Box, Center, Group, Table, Text, TextInput } from "@mantine/core";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { appsQuery } from "../../api/queries";
import { Icon } from "../../components/Icon";
import { PageHead, StatusLine, VisibilityBadge } from "../../components/primitives";
import { timeAgo } from "../../lib/format";
import { useDeployment } from "../../lib/deployment";
import { appStatus } from "../../lib/appStatus";

/** REAL — the org-wide registry, dense table form (source of truth: Postgres). */
export function RegistryPage() {
  const apps = useQuery(appsQuery);
  const { hostFor } = useDeployment();
  const [q, setQ] = useState("");

  const rows = (apps.data ?? []).filter((a) =>
    (a.displayName + a.slug).toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Admin"
        title="All Apps"
        sub="All registered apps."
        actions={
          <TextInput
            placeholder="Search registry…"
            leftSection={<Icon name="search" size={14} />}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            w={240}
          />
        }
      />

      <Box
        style={{
          border: "1px solid var(--az-line)",
          borderRadius: "var(--mantine-radius-lg)",
          overflow: "hidden",
          background: "var(--mantine-color-dark-7)",
        }}
      >
        <Table verticalSpacing="sm" horizontalSpacing="lg" highlightOnHover>
          <Table.Thead style={{ background: "var(--mantine-color-dark-6)" }}>
            <Table.Tr>
              <Table.Th>App</Table.Th>
              <Table.Th>Visibility</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th>Updated</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td>
                  <Group
                    gap={11}
                    wrap="nowrap"
                    component={Link}
                    {...{ to: `/apps/${a.slug}` }}
                    style={{ color: "inherit", textDecoration: "none" }}
                  >
                    <Center
                      w={32}
                      h={32}
                      style={{
                        borderRadius: 8,
                        background: "var(--mantine-color-dark-5)",
                        border: "1px solid var(--az-line-2)",
                        flexShrink: 0,
                      }}
                    >
                      <Text ff="heading" fw={600} fz={13} c="dark.1">
                        {a.displayName[0]?.toUpperCase()}
                      </Text>
                    </Center>
                    <Box>
                      <Text fz={13.5} fw={600}>
                        {a.displayName}
                      </Text>
                      <Text className="az-mono" fz={11} c="dark.2">
                        {hostFor(a)}
                      </Text>
                    </Box>
                  </Group>
                </Table.Td>
                <Table.Td>
                  <VisibilityBadge visibility={a.visibility} />
                </Table.Td>
                <Table.Td>
                  <StatusLine kind={appStatus(a)} />
                </Table.Td>
                <Table.Td>
                  <Text className="az-mono" fz={12} c="dark.2">
                    {new Date(a.createdAt).toLocaleDateString()}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text className="az-mono" fz={12} c="dark.2">
                    {timeAgo(a.updatedAt)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
            {apps.isSuccess && rows.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Text ta="center" c="dark.2" py={24} fz={13}>
                    {q ? "Nothing matches." : "Registry is empty."}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Box>
    </div>
  );
}
