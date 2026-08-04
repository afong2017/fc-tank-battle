type Direction = "up" | "down" | "left" | "right";
type TankKind = "player" | "player2" | "basic" | "fast" | "armor";
type TileCode = "." | "B" | "S" | "W" | "F" | "E";

interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Tank extends RectLike {
  kind: TankKind;
  enemy: boolean;
  dir: Direction;
  baseSpeed: number;
  maxSpeed: number;
  speed: number;
  hp: number;
  color: string;
  fireDelay: number;
  maxBullets: number;
  alive: boolean;
  cooldown: number;
  invuln: number;
  ai: number;
  stuck: number;
  escapeTime: number;
  escapeDir: Direction | null;
  avoidDir: Direction | null;
  turnCooldown: number;
  motionDir: Direction;
  motionUntil: number;
  attackTarget: Tank | null;
  lockedBaseTarget: Tank | null;
  attackRoute: PointLike[] | null;
  attackRouteTarget: Tank | null;
  attackRouteMode: string | null;
  midlineRecorded: boolean;
  box(): RectLike;
}

interface Bullet extends RectLike {
  owner: Tank;
  enemy: boolean;
  dir: Direction;
  speed: number;
  aiControlled?: boolean;
  dead?: boolean;
}

interface PointLike {
  x: number;
  y: number;
}

interface Bonus extends RectLike {
  type: "freeze";
  ttl: number;
  dead?: boolean;
}

interface AiController {
  readonly mode: string;
  memory?: { weights?: Partial<Record<"defend" | "survive" | "attack" | "clear", number>> };
  decide(ctx: unknown, dt?: number): { dir?: Direction; fire?: boolean; hold?: boolean; mode?: string; target?: Tank | null };
  learn(event: string, amount?: number): void;
  snapshot(): unknown;
  restore?(snapshot: unknown): boolean;
}

interface TankPartnerAI {
  __engine?: string;
  engineVersion?: string;
  createController(name: "1P" | "2P"): AiController;
  readMemory(): Record<string, unknown>;
  readPolicy(stage?: number, run?: unknown): Partial<Record<"defend" | "survive" | "attack" | "clear", number>>;
  readExperience(): Record<string, unknown>;
  readExperienceDbStats(): Promise<unknown> | unknown;
  readTraining(): { seconds: number; games: number };
  startMatch(meta?: Record<string, unknown>): void;
  recordExperience(type: string, detail?: Record<string, unknown>): void;
  finishMatch(result?: Record<string, unknown>): void;
  interruptMatch(meta?: Record<string, unknown>): boolean;
  syncMemoryFile(): void;
  syncMemoryFileNow(): void | Promise<void>;
  restoreMemoryFile(): Promise<void>;
  resetMemory(): void;
  addTrainingSeconds(seconds?: number): void;
  incrementTrainingGames(): void;
  flushTraining(): void;
  createHandoff?(): {
    memory: Record<string, unknown>;
    experience: Record<string, unknown>;
    training: { seconds: number; games: number };
    pendingEvents: unknown[];
    pendingMatches: unknown[];
    ownsCurrentMatch: boolean;
    sessionId: string;
    inFlight: Promise<void> | null;
  };
  readonly sessionId: string;
  dispose?(): void;
  ready?: Promise<void>;
}

interface FCGameHotAPI {
  isHotUpgradeEnabled(): boolean;
  setHotUpgradeEnabled(value: boolean): void;
  reloadAiControllers(): void;
  setHotUpgradeStatus(status: string): void;
  canApplyGameUpgrade(): boolean;
  setPendingGameUpgrade(value: boolean): void;
  setAiVersionInfo(info: unknown): void;
  setGameVersionInfo(info: unknown): void;
  resetAiTrainingDisplay(): void;
}

interface FCHotUpgrade {
  checkNow(): Promise<void>;
  applyPendingGameUpgrade(): boolean;
  setEnabled(value: boolean): void;
  current(): unknown;
}

interface Window {
  TankPartnerAI?: TankPartnerAI;
  TankPartnerAIEngine?: { version: string; enhance(api: TankPartnerAI): TankPartnerAI };
  FCGameHotAPI?: FCGameHotAPI;
  FCHotUpgrade?: FCHotUpgrade;
  FCHotUpgradeVersion?: { ai?: Record<string, unknown>; game?: Record<string, unknown> };
  __TankAIDistanceWorkerCache?: Map<string, unknown>;
  webkitAudioContext?: typeof AudioContext;
}

interface Gamepad {
  hapticActuators?: Array<{
    pulse?: (value: number, duration: number) => Promise<boolean>;
  }>;
}
