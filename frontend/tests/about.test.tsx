import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AboutPage, { TEST_COUNTS } from "@/app/about/page";

describe("About page", () => {
  it("covers the four sections, steps and safeguards", () => {
    render(<AboutPage />);
    for (const name of [/Infrastructure SLAs/, /Why PulseSLA/, /From deposit to payout/, /Four safeguards/, /Verified, not asserted/]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(10);
    expect(screen.getByText("Pre-activation health verification")).toBeInTheDocument();
    expect(screen.getByText("7-day linear payout vesting")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Closing the structural gaps/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /What PulseSLA does not claim/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Residual risk 1/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Residual risk 2/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Residual risk 3/ })).toBeInTheDocument();
    expect(screen.getByText(/DEPOSITS_FROZEN_DURING_PENDING_CLAIMS/)).toBeInTheDocument();
    expect(screen.getByText(/Withdrawals are not frozen/)).toBeInTheDocument();
    expect(screen.getByText(/up to the protocol's 80% maximum utilization cap/)).toBeInTheDocument();
    expect(screen.getByText(/economic invariant/)).toBeInTheDocument();
    expect(screen.getByText(/absorbs the full pending reserved liability/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /not continuous pings/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /validated in the test harness/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /GenLayer docs/ })).toHaveAttribute("href", "https://docs.genlayer.com");
  });

  it("states the real test counts", () => {
    render(<AboutPage />);
    expect(screen.getByTestId("contract-tests")).toHaveTextContent(String(TEST_COUNTS.contract));
    expect(screen.getByTestId("frontend-tests")).toHaveTextContent(String(TEST_COUNTS.frontend));
  });
});
