import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  Button,
  Card,
  Center,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import {
  OPERATOR_DESCRIPTION_MAX,
  OPERATOR_NAME_MAX,
  SLUG_TERM_PATTERN,
  type PlatformSettingsResponse,
} from "@azx-pbc/shared";
import {
  blockedSlugTermsQuery,
  platformConfigQuery,
  platformSettingsQuery,
} from "../../api/queries";
import {
  useAddBlockedSlugTerm,
  useRemoveBlockedSlugTerm,
  useUpdatePlatformSettings,
} from "../../api/mutations";
import { Icon } from "../../components/Icon";
import { Eyebrow, Hint, PageHead, ToneBadge } from "../../components/primitives";

/**
 * Platform-wide settings: who runs this instance (shown to anonymous visitors on
 * the sign-in and about pages), app-name terms refused at creation, and the
 * portal's own configuration, read-only.
 */
export function PlatformSettingsPage() {
  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Admin"
        title="Settings"
        sub="Platform-wide settings for this instance. Changes apply to every app."
      />
      <Stack gap={18}>
        <OperatorCard />
        <BlockedTermsCard />
        <ConfigCard />
      </Stack>
    </div>
  );
}

function OperatorCard() {
  const settings = useQuery(platformSettingsQuery);
  const update = useUpdatePlatformSettings();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [contactUrl, setContactUrl] = useState("");

  // Seed the form from the server, and re-seed after a save normalizes it.
  useEffect(() => {
    if (settings.data) resetFrom(settings.data);
  }, [settings.data]);

  function resetFrom(data: PlatformSettingsResponse) {
    setName(data.operatorName ?? "");
    setDescription(data.operatorDescription ?? "");
    setContactUrl(data.operatorContactUrl ?? "");
  }

  const dirty =
    settings.data !== undefined &&
    (name !== (settings.data.operatorName ?? "") ||
      description !== (settings.data.operatorDescription ?? "") ||
      contactUrl !== (settings.data.operatorContactUrl ?? ""));

  return (
    <Card>
      <Eyebrow mb={6}>Operator</Eyebrow>
      <Text size="sm" c="dark.2" mb={12}>
        Shown on the sign-in page of every password-protected app and on the platform&apos;s home
        page, so recipients and their web filters can see who runs this site. Plain text; leave a
        field empty to omit it.
      </Text>
      {settings.isPending && <Loader size="sm" />}
      {settings.isError && (
        <Hint icon="alert" tone="bad">
          Couldn&apos;t load settings: {settings.error.message}
        </Hint>
      )}
      {settings.data && (
        <Stack gap={10}>
          <TextInput
            label="Organization name"
            placeholder="e.g. Example Co"
            value={name}
            maxLength={OPERATOR_NAME_MAX}
            onChange={(e) => setName(e.currentTarget.value)}
            size="xs"
          />
          <Textarea
            label="About"
            description="One or two sentences about who you are and what this site is for."
            placeholder="Example Co builds software for its clients. Apps here are shared with project teams."
            value={description}
            maxLength={OPERATOR_DESCRIPTION_MAX}
            onChange={(e) => setDescription(e.currentTarget.value)}
            minRows={2}
            maxRows={5}
            autosize
            size="xs"
          />
          <TextInput
            label="Contact link"
            description="An https: or mailto: link."
            placeholder="https://example.com/contact"
            value={contactUrl}
            onChange={(e) => setContactUrl(e.currentTarget.value)}
            size="xs"
            classNames={{ input: "az-mono" }}
          />
          <Text size="xs" c="dark.2">
            {settings.data.updatedBy && settings.data.updatedAt
              ? `Last changed by ${settings.data.updatedBy} on ${new Date(settings.data.updatedAt).toLocaleString()}`
              : "Not set yet"}
          </Text>
          {update.isError && (
            <Text size="xs" c="red">
              {update.error.message}
            </Text>
          )}
          <Group justify="flex-end" gap={8}>
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              disabled={!dirty}
              onClick={() => resetFrom(settings.data)}
            >
              Reset
            </Button>
            <Button
              size="xs"
              disabled={!dirty}
              loading={update.isPending}
              onClick={() =>
                update.mutate({
                  operatorName: name,
                  operatorDescription: description,
                  operatorContactUrl: contactUrl,
                })
              }
            >
              Save
            </Button>
          </Group>
        </Stack>
      )}
    </Card>
  );
}

function BlockedTermsCard() {
  const terms = useQuery(blockedSlugTermsQuery);
  const add = useAddBlockedSlugTerm();
  const remove = useRemoveBlockedSlugTerm();
  const [term, setTerm] = useState("");
  const [note, setNote] = useState("");

  const normalized = term.trim().toLowerCase();
  const termValid = SLUG_TERM_PATTERN.test(normalized);

  return (
    <Card>
      <Eyebrow mb={6}>Blocked app-name terms</Eyebrow>
      <Text size="sm" c="dark.2" mb={12}>
        New apps can&apos;t use a name that contains one of these terms as a whole word. Blocking{" "}
        <span className="az-mono">acme</span> refuses <span className="az-mono">acme</span>,{" "}
        <span className="az-mono">acme-demo</span> and <span className="az-mono">q3-acme</span>, but
        not <span className="az-mono">acmeish</span>. Use it for client names: a client&apos;s name
        in a web address next to a sign-in form looks like phishing to web filters.
      </Text>

      <Group gap={8} align="flex-end" mb={12}>
        <TextInput
          label="Term"
          placeholder="acme"
          value={term}
          onChange={(e) => setTerm(e.currentTarget.value)}
          error={
            term.length > 0 && !termValid
              ? "lowercase letters and digits, joined by single hyphens"
              : undefined
          }
          size="xs"
          classNames={{ input: "az-mono" }}
          style={{ flex: "0 0 180px" }}
        />
        <TextInput
          label="Note (optional)"
          placeholder="why it is blocked"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          size="xs"
          style={{ flex: 1 }}
        />
        <Button
          size="xs"
          leftSection={<Icon name="plus" size={12} />}
          disabled={!termValid}
          loading={add.isPending}
          onClick={() =>
            add.mutate(
              { term: normalized, note },
              {
                onSuccess: () => {
                  setTerm("");
                  setNote("");
                },
              },
            )
          }
        >
          Block
        </Button>
      </Group>
      {(add.error ?? remove.error) && (
        <Text size="xs" c="red" mb={8}>
          {(add.error ?? remove.error)?.message}
        </Text>
      )}

      {terms.isPending && <Loader size="sm" />}
      {terms.isError && (
        <Hint icon="alert" tone="bad">
          Couldn&apos;t load blocked terms: {terms.error.message}
        </Hint>
      )}
      {terms.data && terms.data.terms.length === 0 && (
        <Text size="sm" c="dark.2">
          No terms blocked.
        </Text>
      )}
      {terms.data && terms.data.terms.length > 0 && (
        <Table verticalSpacing={6} fz={13}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Term</Table.Th>
              <Table.Th>Note</Table.Th>
              <Table.Th>Added</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {terms.data.terms.map((t) => (
              <Table.Tr key={t.id}>
                <Table.Td className="az-mono">{t.term}</Table.Td>
                <Table.Td>{t.note ?? ""}</Table.Td>
                <Table.Td>
                  <Text size="xs" c="dark.2">
                    {t.createdBy} · {new Date(t.createdAt).toLocaleDateString()}
                  </Text>
                </Table.Td>
                <Table.Td ta="right">
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    aria-label={`unblock ${t.term}`}
                    loading={remove.isPending && remove.variables === t.id}
                    onClick={() => remove.mutate(t.id)}
                  >
                    Remove
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {terms.data && terms.data.matchingApps.length > 0 && (
        <Stack gap={6} mt={14}>
          <Hint icon="alert" tone="warn">
            These existing apps use a blocked term. Blocking only applies to new apps; archive or
            recreate these if their addresses should change.
          </Hint>
          <Group gap={6}>
            {terms.data.matchingApps.map((a) => (
              <Link key={a.slug} to={`/apps/${encodeURIComponent(a.slug)}`}>
                <ToneBadge tone="warn" icon="layers">
                  {a.slug} ({a.term})
                </ToneBadge>
              </Link>
            ))}
          </Group>
        </Stack>
      )}
    </Card>
  );
}

function ConfigCard() {
  const config = useQuery(platformConfigQuery);
  return (
    <Card>
      <Eyebrow mb={6}>Portal configuration</Eyebrow>
      <Text size="sm" c="dark.2" mb={12}>
        Environment variables this portal was started with. Read-only: change them in the
        deployment. Secrets show only whether they are set. The edge and egress services have their
        own settings, which are not listed here.
      </Text>
      {config.isPending && (
        <Center py={20}>
          <Loader size="sm" />
        </Center>
      )}
      {config.isError && (
        <Hint icon="alert" tone="bad">
          Couldn&apos;t load configuration: {config.error.message}
        </Hint>
      )}
      {config.data && (
        <Table verticalSpacing={6} fz={12}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Variable</Table.Th>
              <Table.Th>Value</Table.Th>
              <Table.Th>What it controls</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {config.data.entries.map((e) => (
              <Table.Tr key={e.name}>
                <Table.Td className="az-mono">{e.name}</Table.Td>
                <Table.Td className="az-mono" style={{ wordBreak: "break-all" }}>
                  {e.secret ? (
                    <ToneBadge tone={e.set ? "live" : "neutral"} icon="lock">
                      {e.set ? "set (secret)" : "not set"}
                    </ToneBadge>
                  ) : e.set ? (
                    e.value
                  ) : (
                    <Text span size="xs" c="dark.3">
                      not set
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dark.2">
                    {e.description}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Card>
  );
}
