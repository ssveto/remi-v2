import type { Card } from "./card";

export enum GameEventType {
  // Game initialization
  GAME_STARTED = "GAME_STARTED",
  
  // Card movement events
  CARD_DRAWN_FROM_DECK = "CARD_DRAWN_FROM_DECK",
  CARD_DRAWN_FROM_DISCARD = "CARD_DRAWN_FROM_DISCARD",
  CARD_DISCARDED = "CARD_DISCARDED",
  
  // Meld events
  MELDS_LAID_DOWN = "MELDS_LAID_DOWN",
  CARD_ADDED_TO_MELD = "CARD_ADDED_TO_MELD",
  MELD_VALIDATION_RESULT = "MELD_VALIDATION_RESULT",
  
  // Hand management
  HAND_REORDERED = "HAND_REORDERED",
  
  // Turn management
  PHASE_CHANGED = "PHASE_CHANGED",
  TURN_ENDED = "TURN_ENDED",
  PLAYER_TURN_STARTED = "PLAYER_TURN_STARTED",
  
  // Deck events
  DRAW_PILE_SHUFFLED = "DRAW_PILE_SHUFFLED",
  DRAW_PILE_EMPTY = "DRAW_PILE_EMPTY",
  
  // Game end
  GAME_OVER = "GAME_OVER",
}

/**
 * Base interface for all game events.
 * Each specific event extends this with its own data.
 */
export interface GameEvent {
  type: GameEventType;
  timestamp: number;
}

// Specific event interfaces with typed data
export interface GameStartedEvent extends GameEvent {
  type: GameEventType.GAME_STARTED;
  numPlayers: number;
  startingPlayer: number;
}

export interface CardDrawnEvent extends GameEvent {
  type: GameEventType.CARD_DRAWN_FROM_DECK | GameEventType.CARD_DRAWN_FROM_DISCARD;
  playerIndex: number;
  card: Card; // The card that was drawn (only visible to that player)
  handSize: number; // New hand size
}

export interface CardDiscardedEvent extends GameEvent {
  type: GameEventType.CARD_DISCARDED;
  playerIndex: number;
  card: Card;
  handSize: number;
}

export interface MeldsLaidDownEvent extends GameEvent {
  type: GameEventType.MELDS_LAID_DOWN;
  playerIndex: number;
  melds: Card[][];
  meldScore: number;
  playerHasOpened: boolean; // Did this player just open for first time?
}

export interface CardAddedToMeldEvent extends GameEvent {
  type: GameEventType.CARD_ADDED_TO_MELD;
  playerIndex: number;
  card: Card;
  meldIndex: number; // Which existing meld was extended
  meldOwner: number;
  replacedJoker?: Card | null;
}

export interface MeldValidationResultEvent extends GameEvent {
  type: GameEventType.MELD_VALIDATION_RESULT;
  cards: Card[];
  validMelds: Card[][];
  totalScore: number;
  meetsOpenRequirement: boolean;
}

export interface PhaseChangedEvent extends GameEvent {
  type: GameEventType.PHASE_CHANGED;
  newPhase: GamePhase;
  currentPlayer: number;
}

export interface TurnEndedEvent extends GameEvent {
  type: GameEventType.TURN_ENDED;
  previousPlayer: number;
  nextPlayer: number;
}

export interface PlayerTurnStartedEvent extends GameEvent {
  type: GameEventType.PLAYER_TURN_STARTED;
  playerIndex: number;
  phase: GamePhase;
}

export interface DrawPileShuffledEvent extends GameEvent {
  type: GameEventType.DRAW_PILE_SHUFFLED;
  newDrawPileSize: number;
}

export interface GameOverEvent extends GameEvent {
  type: GameEventType.GAME_OVER;
  winner: number;
  scores: number[];
}

// Union type of all possible events
export type AnyGameEvent = 
  | GameStartedEvent
  | CardDrawnEvent
  | CardDiscardedEvent
  | MeldsLaidDownEvent
  | CardAddedToMeldEvent
  | MeldValidationResultEvent
  | PhaseChangedEvent
  | TurnEndedEvent
  | PlayerTurnStartedEvent
  | DrawPileShuffledEvent
  | GameOverEvent;

/**
 * Simple event emitter for game events.
 * WHY: Provides type-safe event subscription and emission.
 */
export class GameEventEmitter {
  private listeners: Map<GameEventType, Array<(event: AnyGameEvent) => void>> = new Map();

  /**
   * Subscribe to a specific event type.
   * WHY: Visual layer needs to react to specific state changes.
   */
  on(eventType: GameEventType, callback: (event: AnyGameEvent) => void): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    this.listeners.get(eventType)!.push(callback);
    
    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get(eventType);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) {
          callbacks.splice(index, 1);
        }
      }
    };
  }

  /**
   * Emit an event to all subscribers.
   * WHY: Logic layer notifies visual layer of state changes.
   */
  emit(event: AnyGameEvent): void {
    const callbacks = this.listeners.get(event.type);
    if (callbacks) {
      callbacks.forEach(callback => callback(event));
    }
  }

  /**
   * Clear all listeners (useful for cleanup).
   */
  clear(): void {
    this.listeners.clear();
  }
}

// =============================================================================
// PART 2: GAME STATE TYPES
// =============================================================================

/**
 * Game phases that control what actions are valid.
 * WHY: Enforces turn structure at the logic level.
 */
export enum GamePhase {
  DRAW = "DRAW",
  MELD = "MELD",
  DISCARD = "DISCARD",
  GAME_OVER = "GAME_OVER",
}

/**
 * Card interface (simplified for this example).
 */
// export interface Card {
//   suit: "HEART" | "DIAMOND" | "SPADE" | "CLUB" | "JOKER_RED" | "JOKER_BLACK";
//   value: number; // 1-13 for regular cards, 14 for jokers
//   isFaceUp: boolean;
//   flip(): void;
// }

/**
 * Read-only game state snapshot.
 * WHY: Visual layer can inspect state without modifying it.
 */
export interface GameStateSnapshot {
  currentPlayer: number;
  phase: GamePhase;
  numPlayers: number;
  drawPileSize: number;
  discardPileSize: number;
  topDiscardCard: Card | null;
  playersHaveOpened: boolean[]; // Has each player laid their initial meld?
  handSizes: number[]; // Size of each player's hand
}