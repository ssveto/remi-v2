import {
  CARD_SUIT_TO_COLOR,
  type CardSuit,
  type CardSuitColor,
  type CardValue,
} from "./common";

export class Card {
  readonly id: string;
  #suit: CardSuit;
  #value: CardValue;
  #faceUp: boolean;

  constructor(suit: CardSuit, value: CardValue, isFaceUp = false) {
    this.#faceUp = isFaceUp;
    this.#suit = suit;
    this.#value = value;
    this.id = `${suit}_${value}_${this.#generateShortId()}`;
  }
  get suit(): CardSuit {
    return this.#suit;
  }
  get value(): CardValue {
    return this.#value;
  }
  get isFaceUp(): boolean {
    return this.#faceUp;
  }
  get color(): CardSuitColor {
    return CARD_SUIT_TO_COLOR[this.#suit];
  }
  public flip(): void {
    this.#faceUp = !this.#faceUp;
  }

  #generateShortId(): string {
    // Use crypto.randomUUID if available (browser/node 16+)
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID().slice(0, 8);
    }
    
    // Fallback: timestamp + random
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  // ✅ ADDED: Utility method for comparisons
  public equals(other: Card): boolean {
    return this.id === other.id;
  }

  // ✅ ADDED: Utility method for debugging
  public toString(): string {
    return `${this.#value}${this.#suit[0]} [${this.id.slice(-8)}]`;
  }
}
