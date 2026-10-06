import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWallet } from "@/lib/hooks/useWallet";
import { fakeWallet } from "./utils";

describe("useWallet", () => {
  it("reports unavailable when no wallet is injected", () => {
    const { result } = renderHook(() => useWallet(null));
    expect(result.current.status).toBe("unavailable");
    expect(result.current.account).toBeNull();
  });

  it("starts disconnected and connects on request (account lower-cased)", async () => {
    const w = fakeWallet();
    const { result } = renderHook(() => useWallet(w.provider));
    await waitFor(() => expect(result.current.status).toBe("disconnected"));
    await act(async () => { await result.current.connect(); });
    expect(result.current).toMatchObject({ status: "connected", account: "0xabc0000000000000000000000000000000000001", chainId: 61997, wrongNetwork: false });
  });

  it("restores an authorised session without prompting", async () => {
    const w = fakeWallet({ accounts: ["0xAAA0000000000000000000000000000000000002"] });
    const { result } = renderHook(() => useWallet(w.provider));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(w.calls).not.toContain("eth_requestAccounts");
  });

  it("surfaces a rejected connection request", async () => {
    const w = fakeWallet({ rejectConnect: true });
    const { result } = renderHook(() => useWallet(w.provider));
    await act(async () => { await result.current.connect(); });
    expect(result.current.status).toBe("disconnected");
    expect(result.current.error).toMatch(/rejected/i);
  });

  it("flags the wrong network and switches", async () => {
    const w = fakeWallet({ accounts: ["0xAAA0000000000000000000000000000000000002"], chainId: "0x1" });
    const { result } = renderHook(() => useWallet(w.provider));
    await waitFor(() => expect(result.current.wrongNetwork).toBe(true));
    await act(async () => { await result.current.switchNetwork(); });
    act(() => w.emit("chainChanged", "0xf22d"));
    await waitFor(() => expect(result.current.wrongNetwork).toBe(false));
    expect(w.calls).toContain("wallet_switchEthereumChain");
  });

  it("tracks account changes and disconnects locally", async () => {
    const w = fakeWallet({ accounts: ["0xAAA0000000000000000000000000000000000002"] });
    const { result } = renderHook(() => useWallet(w.provider));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    act(() => w.emit("accountsChanged", ["0xBBB0000000000000000000000000000000000003"]));
    expect(result.current.account).toBe("0xbbb0000000000000000000000000000000000003");
    act(() => w.emit("accountsChanged", []));
    expect(result.current.status).toBe("disconnected");
    act(() => result.current.disconnect());
    expect(result.current.account).toBeNull();
  });

  it("connect without a wallet explains why", async () => {
    const { result } = renderHook(() => useWallet(null));
    await act(async () => { await result.current.connect(); });
    expect(result.current.error).toMatch(/No injected wallet/);
  });
});
