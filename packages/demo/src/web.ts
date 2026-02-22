import { Buffer } from "buffer";
(window as any).Buffer = Buffer;
import "./web.css";

// ─── Tier definitions (mirrors @proofoflove/core tiers) ───
const TIERS = [
  { tier: 1, label: "Seed", emoji: "🌱", lower: 0, upper: 100_000 },
  { tier: 2, label: "Sprout", emoji: "🌿", lower: 100_000, upper: 1_000_000 },
  { tier: 3, label: "Tree", emoji: "🌳", lower: 1_000_000, upper: 5_000_000 },
  {
    tier: 4,
    label: "Mountain",
    emoji: "🏔️",
    lower: 5_000_000,
    upper: 25_000_000,
  },
  {
    tier: 5,
    label: "Ocean",
    emoji: "🌊",
    lower: 25_000_000,
    upper: 100_000_000,
  },
  {
    tier: 6,
    label: "Moon",
    emoji: "🌕",
    lower: 100_000_000,
    upper: 500_000_000,
  },
  {
    tier: 7,
    label: "Sun",
    emoji: "☀️",
    lower: 500_000_000,
    upper: 10_000_000_000_000_000,
  },
];

function getTierForBalance(cents: number) {
  for (const t of TIERS) {
    if (cents >= t.lower && cents < t.upper) return t;
  }
  return TIERS[0];
}

function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

// ─── State ───
type Step = "landing" | "config" | "fetching" | "proving" | "result";

interface AppState {
  step: Step;
  heliusApiKey: string;
  ethereumRpcUrl: string;
  arbitrumRpcUrl: string;
  baseRpcUrl: string;
  solanaWallets: string;
  evmWallets: string;
  userSecret: string;
  logs: string[];
  balances: [number, number, number] | null;
  avgBalance: number;
  proofTier: (typeof TIERS)[0] | null;
  proofTimestamp: number;
  proofValid: boolean;
  error: string | null;
}

const state: AppState = {
  step: "landing",
  heliusApiKey: "",
  ethereumRpcUrl: "",
  arbitrumRpcUrl: "",
  baseRpcUrl: "",
  solanaWallets: "",
  evmWallets: "",
  userSecret: "my-secret-phrase",
  logs: [],
  balances: null,
  avgBalance: 0,
  proofTier: null,
  proofTimestamp: 0,
  proofValid: false,
  error: null,
};

// ─── Render ───
const app = document.getElementById("app")!;

function render() {
  switch (state.step) {
    case "landing":
      renderLanding();
      break;
    case "config":
      renderConfig();
      break;
    case "fetching":
    case "proving":
      renderProgress();
      break;
    case "result":
      renderResult();
      break;
  }
}

function renderLanding() {
  app.innerHTML = `
    <div class="landing">
      <div class="landing-bg"></div>
      <div class="landing-content">
        <div class="landing-badge">ZK-VERIFIED</div>
        <h1 class="landing-title">
          Proof of<br/><em>Love</em>
        </h1>
        <p class="landing-subtitle">
          Cryptographically prove your wealth tier<br/>
          without revealing a single number.
        </p>
        <div class="tier-ribbon">
          ${TIERS.map((t) => `<span class="tier-chip">${t.emoji}</span>`).join("")}
        </div>
        <button class="btn-primary" id="btn-start">
          Connect Wallets
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
        <p class="landing-footnote">Zero-knowledge proofs powered by Groth16 · Solana + EVM</p>
      </div>
    </div>
  `;
  document.getElementById("btn-start")!.addEventListener("click", () => {
    state.step = "config";
    render();
  });
}

function renderConfig() {
  app.innerHTML = `
    <div class="config-page">
      <button class="btn-back" id="btn-back">← Back</button>
      <div class="config-card">
        <h2 class="config-title">Configure Wallets</h2>
        <p class="config-desc">Enter your RPC keys and wallet addresses. All processing happens locally in your browser.</p>

        <div class="form-grid">
          <div class="form-section">
            <h3 class="section-label">🔑 API Keys</h3>
            <label class="form-label">
              Helius API Key <span class="label-hint">(Solana)</span>
              <input type="text" class="form-input" id="input-helius" value="${state.heliusApiKey}" placeholder="your-helius-api-key" />
            </label>
            <label class="form-label">
              Ethereum RPC URL
              <input type="text" class="form-input" id="input-eth-rpc" value="${state.ethereumRpcUrl}" placeholder="https://eth-mainnet.g.alchemy.com/v2/..." />
            </label>
            <label class="form-label">
              Arbitrum RPC URL
              <input type="text" class="form-input" id="input-arb-rpc" value="${state.arbitrumRpcUrl}" placeholder="https://arb-mainnet.g.alchemy.com/v2/..." />
            </label>
            <label class="form-label">
              Base RPC URL
              <input type="text" class="form-input" id="input-base-rpc" value="${state.baseRpcUrl}" placeholder="https://base-mainnet.g.alchemy.com/v2/..." />
            </label>
          </div>

          <div class="form-section">
            <h3 class="section-label">👛 Wallets</h3>
            <label class="form-label">
              Solana Wallets <span class="label-hint">(one per line)</span>
              <textarea class="form-textarea" id="input-sol-wallets" rows="3" placeholder="Your Solana address...">${state.solanaWallets}</textarea>
            </label>
            <label class="form-label">
              EVM Wallets <span class="label-hint">(one per line, shared across ETH/ARB/Base/HyperEVM)</span>
              <textarea class="form-textarea" id="input-evm-wallets" rows="3" placeholder="0x your EVM address...">${state.evmWallets}</textarea>
            </label>
            <label class="form-label">
              Secret Phrase <span class="label-hint">(for nullifier)</span>
              <input type="text" class="form-input" id="input-secret" value="${state.userSecret}" placeholder="my-secret-phrase" />
            </label>
          </div>
        </div>

        ${state.error ? `<div class="error-banner">${state.error}</div>` : ""}

        <button class="btn-primary btn-full" id="btn-prove">
          Generate Proof
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        </button>
      </div>
    </div>
  `;

  document.getElementById("btn-back")!.addEventListener("click", () => {
    state.step = "landing";
    state.error = null;
    render();
  });

  document.getElementById("btn-prove")!.addEventListener("click", () => {
    state.heliusApiKey = (
      document.getElementById("input-helius") as HTMLInputElement
    ).value.trim();
    state.ethereumRpcUrl = (
      document.getElementById("input-eth-rpc") as HTMLInputElement
    ).value.trim();
    state.arbitrumRpcUrl = (
      document.getElementById("input-arb-rpc") as HTMLInputElement
    ).value.trim();
    state.baseRpcUrl = (
      document.getElementById("input-base-rpc") as HTMLInputElement
    ).value.trim();
    state.solanaWallets = (
      document.getElementById("input-sol-wallets") as HTMLTextAreaElement
    ).value.trim();
    state.evmWallets = (
      document.getElementById("input-evm-wallets") as HTMLTextAreaElement
    ).value.trim();
    state.userSecret = (
      document.getElementById("input-secret") as HTMLInputElement
    ).value.trim();

    if (!state.solanaWallets && !state.evmWallets) {
      state.error = "Please enter at least one wallet address.";
      render();
      return;
    }

    state.error = null;
    state.logs = [];
    state.step = "fetching";
    render();
    startProofFlow();
  });
}

function renderProgress() {
  const isFetching = state.step === "fetching";
  app.innerHTML = `
    <div class="progress-page">
      <div class="progress-card">
        <div class="progress-icon">${isFetching ? "🔍" : "🔐"}</div>
        <h2 class="progress-title">${isFetching ? "Fetching Balances" : "Generating ZK Proof"}</h2>
        <p class="progress-desc">${
          isFetching
            ? "Querying historical balances across all chains..."
            : "Creating your zero-knowledge proof. This may take 10-20 seconds..."
        }</p>
        <div class="spinner"></div>
        <div class="log-box" id="log-box">
          ${state.logs.map((l) => `<div class="log-line">${escapeHtml(l)}</div>`).join("")}
        </div>
      </div>
    </div>
  `;
  scrollLogBox();
}

function renderResult() {
  const tier = state.proofTier!;
  app.innerHTML = `
    <div class="result-page">
      <div class="result-card">
        <div class="result-badge-glow tier-glow-${tier.tier}"></div>
        <div class="result-emoji">${tier.emoji}</div>
        <div class="result-tier-label">${tier.label}</div>
        <div class="result-tier-num">Tier ${tier.tier}</div>

        <div class="result-divider"></div>

        <div class="result-stats">
          <div class="stat">
            <span class="stat-label">Proof Status</span>
            <span class="stat-value ${state.proofValid ? "stat-valid" : "stat-invalid"}">
              ${state.proofValid ? "✅ Valid" : "❌ Invalid"}
            </span>
          </div>
          <div class="stat">
            <span class="stat-label">Timestamp</span>
            <span class="stat-value">${new Date(state.proofTimestamp * 1000).toISOString()}</span>
          </div>
        </div>

        <div class="result-privacy">
          <h4>🔒 What the verifier knows</h4>
          <p>Your wealth tier is <strong>${tier.emoji} ${tier.label}</strong>.</p>
          <p class="privacy-hidden">They do NOT know your exact balance, which wallets you own, or which chains your funds are on.</p>
        </div>

        <button class="btn-primary btn-full" id="btn-restart">
          Start Over
        </button>
      </div>
    </div>
  `;

  document.getElementById("btn-restart")!.addEventListener("click", () => {
    state.step = "config";
    state.error = null;
    state.logs = [];
    render();
  });
}

// ─── Helpers ───
function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function scrollLogBox() {
  const box = document.getElementById("log-box");
  if (box) box.scrollTop = box.scrollHeight;
}

function addLog(msg: string) {
  state.logs.push(msg);
  const box = document.getElementById("log-box");
  if (box) {
    box.innerHTML += `<div class="log-line">${escapeHtml(msg)}</div>`;
    box.scrollTop = box.scrollHeight;
  }
}

// ─── Proof Flow ───
async function startProofFlow() {
  try {
    const { SolanaAdapter, EthereumAdapter, BalanceAggregator } =
      await import("@proofoflove/chain-adapters");
    const { WealthProver, WealthVerifier, generateNullifier, getTierBadge } =
      await import("@proofoflove/core");

    const wallets: Array<{ chain: string; address: string }> = [];
    const solAddrs = state.solanaWallets
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const evmAddrs = state.evmWallets
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const addr of solAddrs)
      wallets.push({ chain: "solana", address: addr });
    for (const addr of evmAddrs) {
      wallets.push({ chain: "ethereum", address: addr });
      wallets.push({ chain: "arbitrum", address: addr });
      wallets.push({ chain: "base", address: addr });
      wallets.push({ chain: "hyperevm", address: addr });
    }

    addLog(`Registered ${wallets.length} wallet(s) across all chains`);

    const aggregator = new BalanceAggregator();

    if (state.heliusApiKey) {
      aggregator.registerAdapter(
        new SolanaAdapter({
          apiKey: state.heliusApiKey,
          network: "mainnet-beta",
        }),
      );
      addLog("✓ Solana adapter registered");
    }
    if (state.ethereumRpcUrl) {
      aggregator.registerAdapter(
        new EthereumAdapter({
          apiKey: state.ethereumRpcUrl,
          network: "ethereum",
        }),
      );
      addLog("✓ Ethereum adapter registered");
    }
    if (state.arbitrumRpcUrl) {
      aggregator.registerAdapter(
        new EthereumAdapter({
          apiKey: state.arbitrumRpcUrl,
          network: "arbitrum",
        }),
      );
      addLog("✓ Arbitrum adapter registered");
    }
    if (state.baseRpcUrl) {
      aggregator.registerAdapter(
        new EthereumAdapter({ apiKey: state.baseRpcUrl, network: "base" }),
      );
      addLog("✓ Base adapter registered");
    }
    aggregator.registerAdapter(
      new EthereumAdapter({
        apiKey: "https://rpc.hyperliquid.xyz/evm",
        network: "hyperevm",
      }),
    );
    addLog("✓ HyperEVM adapter registered");

    const snapshots = BalanceAggregator.generateSnapshots();
    addLog(
      `Snapshots: ${snapshots.map((s) => s.date.toLocaleDateString()).join(", ")}`,
    );

    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args: any[]) => {
      addLog(args.map(String).join(" "));
      origLog(...args);
    };
    console.warn = (...args: any[]) => {
      addLog("⚠ " + args.map(String).join(" "));
      origWarn(...args);
    };

    addLog("Fetching historical balances (this may take 30-60s)...");
    const balances = await aggregator.aggregateBalances(wallets, snapshots);
    state.balances = balances;

    const avgBalance = Math.floor(
      (balances[0] + balances[1] + balances[2]) / 3,
    );
    state.avgBalance = avgBalance;

    state.step = "proving";
    render();

    addLog("Generating nullifier...");
    const nullifier = await generateNullifier(
      wallets.map((w) => w.address),
      state.userSecret,
    );
    addLog(`✓ Nullifier: ${nullifier.toString().slice(0, 16)}...`);

    addLog("Loading circuit artifacts...");
    const wasmResp = await fetch("/circuits/wealth_tier.wasm");
    const zkeyResp = await fetch("/circuits/wealth_tier_final.zkey");

    if (!wasmResp.ok || !zkeyResp.ok) {
      throw new Error(
        "Circuit artifacts not found. Make sure wealth_tier.wasm and wealth_tier_final.zkey are in packages/demo/public/circuits/",
      );
    }

    const wasmBuffer = await wasmResp.arrayBuffer();
    const zkeyBuffer = await zkeyResp.arrayBuffer();
    addLog(
      `✓ Loaded WASM (${(wasmBuffer.byteLength / 1024).toFixed(0)} KB) and zkey (${(zkeyBuffer.byteLength / 1024).toFixed(0)} KB)`,
    );

    addLog("Generating zero-knowledge proof...");
    const prover = new WealthProver();
    const proofData = await prover.generateProofBrowser(
      balances,
      nullifier,
      wasmBuffer,
      zkeyBuffer,
    );
    addLog(`✅ Proof generated! Tier: ${getTierBadge(proofData.tier)}`);

    addLog("Verifying proof...");
    const vkeyResp = await fetch("/circuits/verification_key.json");
    const vkey = await vkeyResp.json();
    const verifier = new WealthVerifier(vkey);
    const result = await verifier.verify(proofData);

    console.log = origLog;
    console.warn = origWarn;

    state.proofTier = getTierForBalance(avgBalance);
    state.proofTimestamp = proofData.timestamp;
    state.proofValid = result.valid;
    state.step = "result";
    render();
  } catch (err: any) {
    console.error("Proof flow error:", err);
    state.error = err.message || "Something went wrong";
    state.step = "config";
    render();
  }
}

// ─── Boot ───
render();
