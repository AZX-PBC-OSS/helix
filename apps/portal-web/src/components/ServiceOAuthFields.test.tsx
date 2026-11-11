import { useState } from "react";
import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SERVICE_ACCOUNT_WARNING } from "@azx-pbc/shared";
import {
  EMPTY_SERVICE_OAUTH,
  ServiceOAuthConfiguration,
  ServiceOAuthCredentials,
  ServiceOAuthDetails,
} from "./ServiceOAuthFields";

function Form() {
  const [recipe, setRecipe] = useState(EMPTY_SERVICE_OAUTH);
  const [value, setValue] = useState("");
  return (
    <MantineProvider>
      <ServiceOAuthConfiguration value={recipe} onChange={setRecipe} />
      <ServiceOAuthCredentials recipe={recipe} value={value} onChange={setValue} />
    </MantineProvider>
  );
}
describe("service-account configuration", () => {
  it("explains shared authority and presents separate client credential fields", () => {
    render(<Form />);
    expect(screen.getByText(SERVICE_ACCOUNT_WARNING)).toBeTruthy();
    expect(screen.getByLabelText("Client ID")).toBeTruthy();
    expect(screen.getByLabelText("Client secret")).toHaveProperty("type", "password");
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "client" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "secret" } });
    expect(screen.getByLabelText("Client ID")).toHaveProperty("value", "client");
  });
  it("supports structured rotation of password-only credentials without inventing a client ID", () => {
    const recipe = {
      ...EMPTY_SERVICE_OAUTH,
      grantType: "password" as const,
      clientAuthentication: "none" as const,
    };
    function Rotation() {
      const [value, setValue] = useState("");
      return (
        <MantineProvider>
          <ServiceOAuthCredentials recipe={recipe} value={value} onChange={setValue} />
        </MantineProvider>
      );
    }
    render(<Rotation />);
    expect(screen.getByLabelText("Client ID (optional)")).toHaveProperty("value", "");
    expect(screen.queryByLabelText("Client secret")).not.toBeTruthy();
    fireEvent.change(screen.getByLabelText("Service account username"), {
      target: { value: "service" },
    });
    fireEvent.change(screen.getByLabelText("Service account password"), {
      target: { value: "private" },
    });
    expect(screen.getByLabelText("Service account username")).toHaveProperty("value", "service");
    expect(screen.getByLabelText("Service account password")).toHaveProperty("type", "password");
  });
  it("makes configuration and needs-attention recovery visible without stored credentials", () => {
    render(
      <MantineProvider>
        <ServiceOAuthDetails
          recipe={{ ...EMPTY_SERVICE_OAUTH, tokenEndpoint: "https://identity.example/token" }}
          status={{ status: "needs_attention", expiresAt: null, retryAfter: null }}
        />
      </MantineProvider>,
    );
    expect(screen.getByText(/Rotate the credentials to retry/)).toBeTruthy();
    expect(screen.getByText(/https:\/\/identity.example\/token/)).toBeTruthy();
    expect(screen.queryByLabelText("Client secret")).not.toBeTruthy();
  });
});
