import { Card } from './card';
import { CARD_SUIT, type CardSuit, type CardValue } from './common';
import { shuffleArray } from './utils';

export class Deck {
  #cards: Card[];
  #drawPile: Card[];
  #discardPile: Card[];

  constructor(numDecks: number = 1) {
    this.#cards = [];
    this.#drawPile = [];
    this.#discardPile = [];
    for (let i = 0; i < numDecks; i++) {
    this.#createDeck();
  }
    this.reset();
  }

  get cards(): Card[] {
    return this.#cards;
  }
  get drawPile(): Card[] {
    return this.#drawPile;
  }
  get discardPile(): Card[] {
    return this.#discardPile;
  }

  public reset(): void {
    this.#discardPile = [];
    this.#drawPile = [...this.#cards];
    this.shuffle();
  }

  public shuffle(): void {
    shuffleArray(this.#drawPile);
  }

  public draw(): Card | undefined {
    return this.#drawPile.shift();
  }
  public shuffleInDiscardPile(): void {
    this.#discardPile.forEach((card) => {
      card.flip();
      this.#drawPile.push(card);
    });
    this.#discardPile = [];
  }
  
  #createDeck(): void {
    const card_suits = Object.values(CARD_SUIT);
    const joker_value: CardValue = 14;
    for (let i = 0; i < 4; i += 1) {
        for (let j = 1; j < 14; j += 1) {
            this.#cards.push(new Card(card_suits[i] as CardSuit, j as CardValue))
        }
    }
    
    this.#cards.push(new Card(card_suits[card_suits.length - 1] as CardSuit, joker_value as CardValue))
    this.#cards.push(new Card(card_suits[card_suits.length - 2] as CardSuit, joker_value as CardValue))

  }
}
