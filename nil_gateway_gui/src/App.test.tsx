import { render, screen } from "@testing-library/react";
import App from "./App";

describe("App shell", () => {
  it("renders the main title", () => {
    render(<App />);
    expect(screen.getByText("NilGateway GUI")).toBeInTheDocument();
  });
});
