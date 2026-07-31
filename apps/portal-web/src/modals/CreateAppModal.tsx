import { useNavigate } from "react-router";
import { Modal, Text } from "@mantine/core";
import { AppCreateForm } from "../components/AppCreateForm";

/**
 * Standalone registration: create an app and go straight to it. The deploy
 * flow embeds the same form (`AppCreateForm`) instead of routing through here,
 * because there the create is step 1 of shipping a build, not a destination.
 */
export function CreateAppModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const navigate = useNavigate();

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Text ff="heading" fw={600}>
          Register an app
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
