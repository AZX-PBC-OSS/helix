import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Alert, Button, Center, Loader, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { authConfigQuery } from "../api/queries";
import { completeLogin } from "./oidc";
import { useAuth } from "./AuthProvider";

/** /auth/callback — the IdP redirects here; exchange the code and bounce back. */
export function CallbackPage() {
  const navigate = useNavigate();
  const { adoptToken } = useAuth();
  const authConfig = useQuery(authConfigQuery);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!authConfig.data || started.current) return;
    started.current = true; // StrictMode double-invokes effects; the code is single-use
    completeLogin(authConfig.data)
      .then(({ accessToken, expiresIn, returnTo }) => {
        adoptToken(accessToken, expiresIn);
        void navigate(returnTo || "/", { replace: true });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [authConfig.data, adoptToken, navigate]);

  return (
    <Center h="100vh">
      {error ? (
        <Alert color="red" title="Sign-in failed" maw={420}>
          <Stack gap="sm">
            <Text size="sm">{error}</Text>
            <Button variant="light" onClick={() => void navigate("/", { replace: true })}>
              Back to the portal
            </Button>
          </Stack>
        </Alert>
      ) : (
        <Stack align="center" gap="sm">
          <Loader />
          <Text c="dimmed" size="sm">
            Completing sign-in…
          </Text>
        </Stack>
      )}
    </Center>
  );
}
