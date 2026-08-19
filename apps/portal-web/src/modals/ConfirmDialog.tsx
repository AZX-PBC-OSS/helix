import type { ReactNode } from "react";
import { Alert, Button, Center, Group, Modal, Stack, Text } from "@mantine/core";
import { Icon, type IconName } from "../components/Icon";

/** Confirmation for pointer flips and lifecycle actions. */
export function ConfirmDialog({
  opened,
  icon,
  tone = "var(--az-warn)",
  toneDim = "var(--az-warn-dim)",
  title,
  body,
  confirmLabel,
  confirmColor,
  loading,
  error,
  onConfirm,
  onClose,
}: {
  opened: boolean;
  icon: IconName;
  tone?: string;
  toneDim?: string;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  confirmColor?: string;
  loading: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onClose} size={440} withCloseButton={false} centered>
      <Stack gap="sm" p={4}>
        <Center w={44} h={44} style={{ borderRadius: 12, background: toneDim, color: tone }}>
          <Icon name={icon} size={22} />
        </Center>
        <Text ff="heading" fw={600} fz={17}>
          {title}
        </Text>
        {/* A div, not Text's default <p>: callers pass block content (a Stack with
            a Textarea, for one), and a <div>/<p> inside a <p> is invalid HTML the
            browser silently re-parents. */}
        <Text component="div" size="sm" c="dark.2" lh={1.5}>
          {body}
        </Text>
        {error && (
          <Alert color="red" py={8}>
            {error}
          </Alert>
        )}
        <Group justify="flex-end" mt="sm">
          <Button variant="subtle" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button
            leftSection={<Icon name={icon} size={14} />}
            color={confirmColor}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
