import { render, screen } from "@testing-library/react";
import App from "./App";

describe("App shell", () => {
  it("renders the main title", async () => {
    render(<App />);
    expect(await screen.findByText("Local Gateway")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PROVIDER TOOLS" })).toBeInTheDocument();
  });
});
