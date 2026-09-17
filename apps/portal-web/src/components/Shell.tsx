import type { ReactNode } from "react";
import { NavLink as RouterNavLink, useLocation } from "react-router";
import {
  Anchor,
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
import { appsQuery } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { Icon, type IconName } from "./Icon";
import { Logo } from "./Logo";
import { Eyebrow, ToneBadge } from "./primitives";
import { useHelp } from "../modals/HelpContext";

/** App chrome: sidebar nav (Workspace / Admin), onboarding, live health. */

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  preview?: boolean;
}

const WORKSPACE_NAV: NavItem[] = [
  { to: "/", label: "Apps", icon: "grid" },
  { to: "/usage", label: "Usage", icon: "gauge" },
];

const ADMIN_NAV: NavItem[] = [
  { to: "/admin/approvals", label: "Approvals", icon: "check" },
  { to: "/admin/audit", label: "Audit Log", icon: "list" },
  { to: "/admin/platform", label: "Activity", icon: "activity" },
  { to: "/admin/secrets", label: "Secrets", icon: "key" },
  { to: "/admin/violations", label: "Violations", icon: "shield" },
];

/**
 * The platform's own upstream repo and issue tracker. Hardcoded because they are
 * product identity — the same precedent as the npm package name printed in
 * `HelpModal` and `repository.url` in the CLI's package.json — not deployment
 * topology, so they deliberately do not come from `GET /api/v1/config`.
 */
const REPO_URL = "https://github.com/AZX-PBC-OSS/helix";
const ISSUES_URL = `${REPO_URL}/issues`;

function Brand() {
  return (
    <Group gap={11} px={4} wrap="nowrap" align="center">
      <Logo height={20} />
      <Box w={1} h={20} style={{ background: "var(--az-line-2)" }} />
      <Text className="az-mono" fz={9} c="dark.2" lts=".18em" style={{ lineHeight: 1.35 }}>
        HELIX
        <br />
        PLATFORM
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

/** Small muted outbound link for the sidebar footer — opens off-platform. */
function FooterLink({ href, icon, children }: { href: string; icon: IconName; children: string }) {
  return (
    <Anchor
      href={href}
      target="_blank"
      rel="noreferrer"
      c="dark.2"
      fz={11}
      className="az-mono"
      style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
    >
      <Icon name={icon} size={11} />
      {children}
    </Anchor>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  // Deployment-wide, not the caller's own: this badge doubles as the portal
  // reachability indicator in the sidebar footer.
  const apps = useQuery(appsQuery("all"));
  const liveCount = apps.data?.filter((a) => !a.archivedAt && a.currentVersionId).length ?? 0;
  const { openHelp } = useHelp();

  return (
    <AppShell navbar={{ width: 248, breakpoint: "xs" }} padding={0}>
      <AppShell.Navbar className="az-glass" p="14px" style={{ borderColor: "var(--az-line-2)" }}>
        <Box px={6} pb={18} pt={4}>
          <Brand />
        </Box>
        {/* Deploying is an app-scoped action and lives on the app's own page;
            creating one lives on the apps page. Neither belongs in the sidebar, where
            a global "Deploy app" button had no target to act on. */}
        <Eyebrow mb={8}>Workspace</Eyebrow>
        <Stack gap={2}>
          {WORKSPACE_NAV.map((item) => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </Stack>

        {isAdmin && (
          <>
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
          </>
        )}

        <Box style={{ flex: 1 }} />
        <Box pt={14} style={{ borderTop: "1px solid var(--az-line)" }}>
          <Button
            variant="default"
            leftSection={<Icon name="book" size={15} />}
            onClick={openHelp}
            fullWidth
            mb={12}
            styles={{ label: { flex: 1, textAlign: "left" } }}
          >
            How to develop
          </Button>
          <Group justify="space-between" px={8} mb={12} wrap="nowrap">
            <FooterLink href={REPO_URL} icon="ext">
              Source code
            </FooterLink>
            <FooterLink href={ISSUES_URL} icon="bug">
              Report a bug
            </FooterLink>
          </Group>
          <Box px={8} pb={12}>
            <ToneBadge tone={apps.isError ? "bad" : "live"} icon="dot">
              {apps.isPending
                ? "Checking…"
                : apps.isError
                  ? "Portal unreachable"
                  : `${liveCount} ${liveCount === 1 ? "app" : "apps"} live`}
            </ToneBadge>
          </Box>
          <UserChip />
        </Box>
      </AppShell.Navbar>

      <AppShell.Main style={{ position: "relative", zIndex: 1 }}>
        <ScrollArea h="100vh" type="auto">
          <Box className="az-screen" p="30px 30px 52px" maw={1160} mx="auto" my={24}>
            {children}
          </Box>
        </ScrollArea>
      </AppShell.Main>
    </AppShell>
  );
}
