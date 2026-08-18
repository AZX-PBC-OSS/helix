import { useNavigate } from "react-router";
import { Modal, Text } from "@mantine/core";
import { AppCreateForm } from "../components/AppCreateForm";

/**
 * Registration, and the SPA's only creation surface: create an app and go
 * straight to its page — which is where you deploy into it. Deliberately a
 * modal rather than a route; the form is two fields plus a visibility choice
 * with one live option, and its destination is the app it just made, so a
 * `/apps/new` URL would be one nobody links to twice. It becomes a page if
 * create ever grows steps (templates, repo import, an approval gate).
 */
export function CreateAppModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const navigate = useNavigate();

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Text ff="heading" fw={600}>
          Create app
        </Text>
      }
      size="lg"
    >
      {/* Mantine unmounts modal children on close, so the form's own state
          (and the create mutation) resets between openings. */}
      <AppCreateForm
        onCancel={onClose}
        onCreated={(app) => {
          onClose();
          void navigate(`/apps/${app.slug}`);
        }}
      />
    </Modal>
  );
}
