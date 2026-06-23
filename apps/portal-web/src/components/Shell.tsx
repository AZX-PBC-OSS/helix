import type { ReactNode } from "react";
import { NavLink as RouterNavLink, useLocation } from "react-router";
import {
  AppShell,
  Avatar,
  Box,
  Button,
  Group,
  Menu,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { healthQuery } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { Icon, type IconName } from "./Icon";
import { Logo } from "./Logo";
import { Eyebrow, ToneBadge } from "./primitives";

/** App chrome: sidebar nav (Workspace / Admin), header with live health. */

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  preview?: boolean;
}

const WORKSPACE_NAV: NavItem[] = [
  { to: "/", label: "My Apps", icon: "grid" },
  { to: "/usage", label: "Usage", icon: "gauge" },
];

const ADMIN_NAV: NavItem[] = [
  { to: "/admin/approvals", label: "Approvals", icon: "check" },
  { to: "/admin/audit", label: "Audit Log", icon: "list" },
  { to: "/admin/platform", label: "Platform", icon: "activity" },
  { to: "/admin/registry", label: "All Apps", icon: "layers" },
  { to: "/admin/secrets", label: "Secrets", icon: "key" },
  { to: "/admin/violations", label: "Violations", icon: "shield" },
];

function Brand() {
  return (
    <Group gap={11} px={4} wrap="nowrap" align="center">
      <Logo height={20} />
      <Box w={1} h={20} style={{ background: "var(--az-line-2)" }} />
      <Text className="az-mono" fz={9} c="dark.2" lts=".18em" style={{ lineHeight: 1.35 }}>
        CONTROL
        <br />
        PLANE
      </Text>
    </Group>
  );
}

function SidebarLink({ item }: { item: NavItem }) {
  const { pathname } = useLocation();
  const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
  return (
    <UnstyledButton
      component={RouterNavLink}
      to={item.to}
      px={11}
      py={9}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        borderRadius: 9,
        position: "relative",
        background: active ? "rgba(255,255,255,.055)" : "transparent",
        color: active ? "var(--mantine-color-dark-0)" : "var(--mantine-color-dark-2)",
        fontSize: 13.5,
        fontWeight: active ? 600 : 500,
        transition: "all .14s",
      }}
    >
      {active && (
        <span
          style={{
            position: "absolute",
            left: -9,
            top: "50%",
            transform: "translateY(-50%)",
            width: 3,
            height: 18,
            background: "var(--az-acc)",
            borderRadius: 3,
          }}
        />
      )}
      <Icon name={item.icon} size={17} style={{ color: active ? "var(--az-acc)" : "inherit" }} />
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.preview && (
        <span
          className="az-mono"
          style={{ fontSize: 8.5, color: "var(--az-violet)", letterSpacing: ".08em" }}
        >
          SOON
        </span>
      )}
    </UnstyledButton>
  );
}

function UserChip() {
  const { authenticated, me, login, loginAvailable, logout } = useAuth();

  if (!authenticated) {
    return (
      <Tooltip
        label={loginAvailable ? "OIDC code + PKCE via the IdP" : "Portal has no IdP configured"}
        position="right"
      >
        <Button
          variant="default"
          leftSection={<Icon name="user" size={14} />}
          rightSection={<Icon name="chevR" size={13} style={{ color: "var(--az-slate)" }} />}
          onClick={login}
          disabled={!loginAvailable}
          fullWidth
          styles={{ label: { flex: 1, textAlign: "left" } }}
        >
          Sign in
        </Button>
      </Tooltip>
    );
  }

  const name = me?.name ?? me?.sub ?? "…";
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <Menu position="right-end" width={200}>
      <Menu.Target>
        <UnstyledButton w="100%" p={8} style={{ borderRadius: 10 }}>
          <Group gap={10} wrap="nowrap">
            <Avatar radius="xl" size={30} color="accent" variant="light">
              {initials}
            </Avatar>
            <Box style={{ minWidth: 0, lineHeight: 1.25 }}>
              <Text size="sm" fw={600} truncate>
                {name}
              </Text>
              <Text className="az-mono" fz={10.5} c="dark.2" truncate>
                {me?.email ?? me?.via ?? ""}
              </Text>
            </Box>
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label className="az-mono">
          {me?.via === "oidc" ? "Signed in via OIDC" : `via ${me?.via ?? "?"}`}
        </Menu.Label>
        <Menu.Item leftSection={<Icon name="x" size={13} />} onClick={logout}>
          Sign out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export function Shell({ children, onDeploy }: { children: ReactNode; onDeploy: () => void }) {
  const health = useQuery(healthQuery);
  const healthy = health.isSuccess;

  return (
    <AppShell navbar={{ width: 248, breakpoint: "xs" }} header={{ height: 62 }} padding={0}>
      <AppShell.Navbar
        p="14px"
        style={{ background: "var(--mantine-color-dark-7)", borderColor: "var(--az-line)" }}
      >
        <Box px={6} pb={18} pt={4}>
          <Brand />
        </Box>
        <Button leftSection={<Icon name="upload" size={15} />} mb={18} onClick={onDeploy}>
          Deploy app
        </Button>

        <Eyebrow mb={8}>Workspace</Eyebrow>
        <Stack gap={2}>
          {WORKSPACE_NAV.map((item) => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </Stack>

        <Group justify="space-between" px={8} pt={18} pb={8}>
          <Eyebrow>Admin</Eyebrow>
          <ToneBadge tone="violet" style={{ padding: "2px 6px", fontSize: 9.5 }}>
            ELEVATED
          </ToneBadge>
        </Group>
        <Stack gap={2}>
          {ADMIN_NAV.map((item) => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </Stack>

        <Box style={{ flex: 1 }} />
        <Box pt={14} style={{ borderTop: "1px solid var(--az-line)" }}>
          <UserChip />
        </Box>
      </AppShell.Navbar>

      <AppShell.Header
        px={28}
        style={{
          background: "rgba(8,9,11,.7)",
          backdropFilter: "blur(8px)",
          borderColor: "var(--az-line)",
        }}
      >
        <Group h="100%" justify="space-between">
          <Text size="sm" c="dark.2">
            Secure hosting for vibe-coded apps —{" "}
            <Text component="span" className="az-mono" c="dark.1" fz={12.5}>
              *.azx-labs.com
            </Text>
          </Text>
          <Group gap={14}>
            <ToneBadge tone={healthy ? "live" : "bad"} icon="dot">
              {healthy
                ? "All systems normal"
                : health.isLoading
                  ? "Checking…"
                  : "Portal unreachable"}
            </ToneBadge>
            <Box w={1} h={22} bg="var(--az-line-2)" />
            <Tooltip label="pnpm --filter @helix/cli azx -- --help">
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                leftSection={<Icon name="terminal" size={14} />}
              >
                CLI
              </Button>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Main style={{ position: "relative", zIndex: 1 }}>
        <ScrollArea h="calc(100vh - 62px)" type="auto">
          <Box p="30px 28px 60px" maw={1180} mx="auto">
            {children}
          </Box>
        </ScrollArea>
      </AppShell.Main>
    </AppShell>
  );
}
