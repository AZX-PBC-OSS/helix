import type { ReactNode } from "react";
import { Box, Button, Card, Center, Loader, Stack, Text } from "@mantine/core";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { PageHead } from "../components/primitives";
import { useAuth } from "./AuthProvider";

/**
 * Access gates for the SPA. The portal API requires sign-in for every read, so
 * `RequireAuth` wraps the whole app; `RequireAdmin` additionally fences the
 * admin routes behind the server-computed `platform-admin` role. Both mirror
 * the server's posture — they're convenience, not the real boundary (the API
 * gates every request regardless).
 */

/** Full-page sign-in screen — the only thing a logged-out visitor ever sees. */
function SignInScreen() {
  const { login, loginAvailable } = useAuth();
  return (
    <Center h="100vh" p="md">
      <Card className="az-glass" maw={400} w="100%" p={36} style={{ textAlign: "center" }}>
        <Stack align="center" gap={18}>
          <Logo height={26} />
          <Box>
            <Text fw={600} fz={18}>
              Sign in to Helix
            </Text>
            <Text c="dark.2" size="sm" mt={6}>
              The platform portal requires a signed-in account. Sign in to view and manage apps.
            </Text>
          </Box>
          <Button
            onClick={login}
            disabled={!loginAvailable}
            leftSection={<Icon name="user" size={15} />}
            fullWidth
          >
            Sign in
          </Button>
          {!loginAvailable && (
            <Text c="dark.2" size="xs">
              This portal has no IdP configured.
            </Text>
          )}
        </Stack>
      </Card>
    </Center>
  );
}

/** Gate the whole app: a token must be present (and /api/v1/me must resolve). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { authenticated, meLoading } = useAuth();
  if (!authenticated) return <SignInScreen />;
  // Token present but identity not yet established — avoid flashing the app
  // before a stale token bounces back to the sign-in screen.
  if (meLoading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  return <>{children}</>;
}

/** Gate an admin route: the actor must hold the `platform-admin` role. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { meLoading, isAdmin } = useAuth();
  if (meLoading) {
    return (
      <Center mih={320}>
        <Loader size="sm" />
      </Center>
    );
  }
  if (!isAdmin) {
    return (
      <div className="az-stagger">
        <PageHead eyebrow="Admin" title="Restricted" />
        <Card py={48} style={{ textAlign: "center" }}>
          <Stack align="center" gap={10}>
            <Icon name="shield" size={26} style={{ color: "var(--az-slate)" }} />
            <Text c="dark.1" fw={600}>
              This area requires the platform-admin role
            </Text>
            <Text c="dark.2" size="sm" maw={420}>
              Your account is signed in but isn't assigned the platform-admin role. Ask a platform
              administrator for access.
            </Text>
          </Stack>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
