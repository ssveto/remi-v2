import { Card } from "./card";
import { Deck } from "./deck";
import { GameEventEmitter, GameEventType, GamePhase, type AnyGameEvent, type GameStateSnapshot } from "./game-event";

export interface MeldValidationResult {
  // Input
  selectedCards: Card[];

  // Analysis
  validMelds: Card[][]; // Groups of cards that form valid melds
  invalidCards: Card[]; // Cards that don't fit in any meld


  // Scoring
  totalScore: number;
  meldScores: number[]; // Score for each valid meld

  // Requirements
  meetsOpenRequirement: boolean; // Can player lay these melds?
  minimumNeeded: number; // How many more points needed to open
  hasOpened: boolean;
}

/**
 * ARCHITECTURE DECISION:
 * This class is PURE LOGIC - it knows nothing about Phaser or visuals.
 * - Manages ALL game state internally
 * - Validates ALL game rules
 * - Emits events when state changes
 * - Provides read-only access to state via getters
 * - Never directly manipulates visual objects
 */
export class Remi {
  // Event emitter for notifying visual layer
  #events = new GameEventEmitter();

  // Game state (PRIVATE - only accessible via methods/getters)
  #deck!: Deck;
  #playerHands: Card[][] = [];
  #playerMelds: Card[][][] = []; // Each player's laid-down melds
  #playersHaveOpened: boolean[] = [];
  #currentPlayer: number = 0;
  #phase: GamePhase = GamePhase.DRAW;
  #numPlayers: number = 0;
  #currentMelds: Card[][] = [];
  #currentScore: number = 0;

  constructor() { }

  public on(eventType: GameEventType, callback: (event: AnyGameEvent) => void): () => void {
    return this.#events.on(eventType, callback);
  }

  public newGame(numPlayers: number = 2): void {
    this.#numPlayers = numPlayers;
    this.#currentPlayer = 0;
    this.#phase = GamePhase.DRAW;

    this.#deck = new Deck(2);
    this.#playerHands = [];
    this.#playerMelds = [];
    this.#playersHaveOpened = Array(numPlayers).fill(false);
    this.#currentMelds = [];
    this.#currentScore = 0;

    for (let i = 0; i < numPlayers; i++) {
      this.#playerHands[i] = [];
      this.#playerMelds[i] = [];
    }

    for (let i = 0; i < 14; i++) {
      for (let p = 0; p < numPlayers; p++) {
        const card = this.#deck.draw()!;
        card.flip();
        this.#playerHands[p].push(card);
      }
    }

    // Emit events
    this.#events.emit({
      type: GameEventType.GAME_STARTED,
      timestamp: Date.now(),
      numPlayers,
      startingPlayer: 0,
    });

    this.#events.emit({
      type: GameEventType.PLAYER_TURN_STARTED,
      timestamp: Date.now(),
      playerIndex: 0,
      phase: GamePhase.DRAW,
    });
  }

  public drawCard(playerIndex: number): boolean {
    // Validate
    if (this.#phase !== GamePhase.DRAW) return false;
    if (playerIndex !== this.#currentPlayer) return false;
    if (this.#playerHands[playerIndex].length >= 15) return false;

    // Handle empty deck
    if (this.#deck.drawPile.length === 0) {
      this.shuffleDiscardIntoDeck();
      if (this.#deck.drawPile.length === 0) return false;
    }

    // Execute
    const card = this.#deck.draw()!;
    card.flip();
    this.#playerHands[playerIndex].push(card);

    // Emit events
    this.#events.emit({
      type: GameEventType.CARD_DRAWN_FROM_DECK,
      timestamp: Date.now(),
      playerIndex,
      card,
      handSize: this.#playerHands[playerIndex].length,
    });

    // Transition to MELD phase
    this.setPhase(GamePhase.MELD);

    return true;
  }

  public drawFromDiscard(playerIndex: number): boolean {
    if (this.#phase !== GamePhase.DRAW) return false;
    if (playerIndex !== this.#currentPlayer) return false;
    if (this.#deck.discardPile.length === 0) return false;
    if (this.#playerHands[playerIndex].length >= 15) return false;

    const card = this.#deck.discardPile.pop()!;
    card.flip();
    this.#playerHands[playerIndex].push(card);

    this.#events.emit({
      type: GameEventType.CARD_DRAWN_FROM_DISCARD,
      timestamp: Date.now(),
      playerIndex,
      card,
      handSize: this.#playerHands[playerIndex].length,
    });

    this.setPhase(GamePhase.MELD);
    return true;
  }

  public validateMelds(
    playerIndex: number,
    selectedCards: Card[]
  ): MeldValidationResult {
    // Early return for too few cards
    if (selectedCards.length < 3) {
      return this.#createEmptyValidation(selectedCards);
    }

    // Split into valid meld groups
    const validMelds = this.#splitIntoMeldGroups(selectedCards);

    // Calculate scores and requirements
    const meldScores = validMelds.map(meld => this.#calculateMeldValue(meld));
    //const totalScore = meldScores.reduce((sum, score) => sum + score, 0);
    this.#currentScore = meldScores.reduce((sum, score) => sum + score, 0);
    const totalScore = this.#currentScore;

    this.#currentMelds = validMelds;

    // Find invalid cards
    const cardsInMelds = new Set(validMelds.flat());
    const invalidCards = selectedCards.filter(c => !cardsInMelds.has(c));

    // Check opening requirements
    const hasOpened = this.#playersHaveOpened[playerIndex];
    const openRequirement = 51;
    const meetsOpenRequirement = hasOpened || totalScore >= openRequirement;
    const minimumNeeded = hasOpened ? 0 : Math.max(0, openRequirement - totalScore);

    return {
      selectedCards,
      validMelds,
      invalidCards,
      totalScore,
      meldScores,
      meetsOpenRequirement,
      minimumNeeded,
      hasOpened,
    };
  }
  public currentScore(): number {
    return this.#currentScore;
  }

  public layDownMelds(playerIndex: number, melds: Card[][]): boolean {
    if (this.#phase !== GamePhase.MELD && this.#phase !== GamePhase.DISCARD) {
      return false;
    }
    if (playerIndex !== this.#currentPlayer) return false;

    // Validate all cards are in hand
    const hand = this.#playerHands[playerIndex];
    const allCardsInHand = melds.flat().every(card => hand.includes(card));
    if (!allCardsInHand) return false;

    // Validate melds
    const allValid = melds.every(meld =>
      this.#isValidSet(meld) || this.#isValidRun(meld)
    );
    if (!allValid) return false;

    // Check opening requirement
    const hasOpened = this.#playersHaveOpened[playerIndex];
    const totalScore = this.#calculateTotalMeldScore(melds);
    if (!hasOpened && totalScore < 51) return false;

    // Execute: Remove from hand, add to table
    melds.flat().forEach(card => {
      const idx = hand.indexOf(card);
      if (idx > -1) hand.splice(idx, 1);
    });
    this.#playerMelds[playerIndex].push(...melds);

    // Update opened status
    if (!hasOpened) {
      this.#playersHaveOpened[playerIndex] = true;
    }

    this.#currentScore = 0;
    this.#currentMelds = [];

    // Emit
    this.#events.emit({
      type: GameEventType.MELDS_LAID_DOWN,
      timestamp: Date.now(),
      playerIndex,
      melds,
      meldScore: totalScore,
      playerHasOpened: this.#playersHaveOpened[playerIndex],
      
    });

    return true;
  }

  public addCardToMeld(
    playerIndex: number,
    card: Card,
    meldOwner: number,
    meldIndex: number
  ): boolean {
    if (this.#phase !== GamePhase.MELD && this.#phase !== GamePhase.DISCARD) {
      return false;
    }
    if (playerIndex !== this.#currentPlayer) return false;
    if (!this.#playersHaveOpened[playerIndex]) return false;

    // Get the meld
    const meld = this.#playerMelds[meldOwner]?.[meldIndex];
    if (!meld) return false;

    // Check card is in hand
    const hand = this.#playerHands[playerIndex];
    if (!hand.includes(card)) return false;

    // Validate extended meld
    const testMeld = [...meld, card];
    if (!this.#isValidSet(testMeld) && !this.#isValidRun(testMeld)) {
      return false;
    }

    // Execute
    const idx = hand.indexOf(card);
    hand.splice(idx, 1);
    meld.push(card);

    // Emit
    this.#events.emit({
      type: GameEventType.CARD_ADDED_TO_MELD,
      timestamp: Date.now(),
      playerIndex,
      card,
      meldIndex,
    });

    return true;
  }

  public discardCard(playerIndex: number, card: Card): boolean {
    if (this.#phase !== GamePhase.MELD && this.#phase !== GamePhase.DISCARD) {
      return false;
    }
    if (playerIndex !== this.#currentPlayer) return false;

    const hand = this.#playerHands[playerIndex];
    const idx = hand.indexOf(card);
    if (idx === -1) return false;

    // Execute
    hand.splice(idx, 1);
    this.#deck.discardPile.push(card);

    // Emit
    this.#events.emit({
      type: GameEventType.CARD_DISCARDED,
      timestamp: Date.now(),
      playerIndex,
      card,
      handSize: hand.length,
    });

    // Check win condition
    if (hand.length === 0) {
      this.endGame(playerIndex);
      return true;
    }

    // End turn
    this.endTurn();
    return true;
  }

  public reorderHand(playerIndex: number, fromIndex: number, toIndex: number): boolean {
    const hand = this.#playerHands[playerIndex];
    if (fromIndex < 0 || fromIndex >= hand.length) return false;
    if (toIndex < 0 || toIndex >= hand.length) return false;

    const [card] = hand.splice(fromIndex, 1);
    hand.splice(toIndex, 0, card);

    return true;
  }

  public getState(): GameStateSnapshot {
    return {
      currentPlayer: this.#currentPlayer,
      phase: this.#phase,
      numPlayers: this.#numPlayers,
      drawPileSize: this.#deck.drawPile.length,
      discardPileSize: this.#deck.discardPile.length,
      topDiscardCard: this.#deck.discardPile[this.#deck.discardPile.length - 1] || null,
      playersHaveOpened: [...this.#playersHaveOpened],
      handSizes: this.#playerHands.map(h => h.length),
    };
  }

  public getPlayerHand(playerIndex: number): Card[] {
    return [...(this.#playerHands[playerIndex] || [])];
  }

  public getPlayerMelds(playerIndex: number): Card[][] {
    return this.#playerMelds[playerIndex]?.map(meld => [...meld]) || [];
  }

  public getCurrentMelds(): Card[][] {
    // Split into valid meld groups
    return this.#currentMelds;
  }

  public hasPlayerOpened(playerIndex: number): boolean {
    return this.#playersHaveOpened[playerIndex] || false;
  }

  private setPhase(newPhase: GamePhase): void {
    this.#phase = newPhase;
    this.#events.emit({
      type: GameEventType.PHASE_CHANGED,
      timestamp: Date.now(),
      newPhase,
      currentPlayer: this.#currentPlayer,
    });
  }

  private endTurn(): void {
    const previousPlayer = this.#currentPlayer;
    this.#currentPlayer = (this.#currentPlayer + 1) % this.#numPlayers;

    this.#events.emit({
      type: GameEventType.TURN_ENDED,
      timestamp: Date.now(),
      previousPlayer,
      nextPlayer: this.#currentPlayer,
    });

    this.setPhase(GamePhase.DRAW);

    this.#events.emit({
      type: GameEventType.PLAYER_TURN_STARTED,
      timestamp: Date.now(),
      playerIndex: this.#currentPlayer,
      phase: this.#phase,
    });
  }

  private endGame(winner: number): void {
    this.setPhase(GamePhase.GAME_OVER);

    // Calculate final scores (simplified)
    const scores = this.#playerHands.map(hand =>
      hand.reduce((sum, card) => sum + this.#cardPointValue(card), 0)
    );

    this.#events.emit({
      type: GameEventType.GAME_OVER,
      timestamp: Date.now(),
      winner,
      scores,
    });
  }

  private shuffleDiscardIntoDeck(): void {
    if (this.#deck.drawPile.length > 0) return;

    this.#deck.shuffleInDiscardPile();

    this.#events.emit({
      type: GameEventType.DRAW_PILE_SHUFFLED,
      timestamp: Date.now(),
      newDrawPileSize: this.#deck.drawPile.length,
    });
  }

  #splitIntoMeldGroups(cards: Card[]): Card[][] {
    const validMelds: Card[][] = [];

    if (cards.length < 3) {
      return validMelds;
    }

    let currentGroup: Card[] = [cards[0]];

    for (let i = 1; i < cards.length; i++) {
      const currentCard = cards[i];
      const lastCardInGroup = currentGroup[currentGroup.length - 1];

      // CRITICAL: Check if cards can be adjacent (no two jokers next to each other)
      if (this.#canCardsBeAdjacent(lastCardInGroup, currentCard)) {
        currentGroup.push(currentCard);

        // Once we have 3+ cards, check if group is valid
        if (currentGroup.length >= 3) {
          const groupResult = this.#evaluateGroup(currentGroup);

          if (!groupResult.isValid && groupResult.validSubgroup) {
            // Save valid subgroup and start new group
            validMelds.push(groupResult.validSubgroup);
            currentGroup = [currentCard];
          }
        }
      } else {
        // Adjacent jokers detected - finalize current group if valid
        if (currentGroup.length >= 3 && this.#isValidMeld(currentGroup)) {
          validMelds.push([...currentGroup]);
        }

        // Start new group with current card
        currentGroup = [currentCard];
      }
    }

    // Check the last group
    if (currentGroup.length >= 3 && this.#isValidMeld(currentGroup)) {
      validMelds.push(currentGroup);
    }

    return validMelds;
  }

  #evaluateGroup(group: Card[]): {
    isValid: boolean;
    validSubgroup: Card[] | null;
  } {
    if (this.#isValidMeld(group)) {
      return { isValid: true, validSubgroup: null };
    }

    // Group is invalid - check if removing last card makes it valid
    if (group.length > 3) {
      const withoutLast = group.slice(0, -1);
      if (withoutLast.length >= 3 && this.#isValidMeld(withoutLast)) {
        return { isValid: false, validSubgroup: withoutLast };
      }
    }

    return { isValid: false, validSubgroup: null };
  }


  #isValidMeld(cards: Card[]): boolean {
    return this.#isValidSet(cards) || this.#isValidRun(cards);
  }

  #isValidSet(cards: Card[]): boolean {
    // Must be 3 or 4 cards
    if (cards.length < 3 || cards.length > 4) {
      return false;
    }

    const jokers = cards.filter(c => this.#isJoker(c));
    const regularCards = cards.filter(c => !this.#isJoker(c));

    // RULE: Maximum 1 joker per SET
    if (jokers.length > 1) {
      return false;
    }

    // Must have at least one regular card
    if (regularCards.length === 0) {
      return false;
    }

    // All regular cards must have same value
    const targetValue = regularCards[0].value;
    const allSameValue = regularCards.every(c => c.value === targetValue);
    if (!allSameValue) {
      return false;
    }

    // All regular cards must have different suits
    const suits = new Set(regularCards.map(c => c.suit));
    const allDifferentSuits = suits.size === regularCards.length;
    if (!allDifferentSuits) {
      return false;
    }

    return true;
  }

  #isValidRun(cards: Card[]): boolean {
    // Must be 3+ cards
    if (cards.length < 3) {
      return false;
    }

    const jokers = cards.filter(c => this.#isJoker(c));
    const regularCards = cards.filter(c => !this.#isJoker(c));

    if (regularCards.length === 0) {
      return false;
    }

    // All regular cards must be same suit
    const targetSuit = regularCards[0].suit;
    const allSameSuit = regularCards.every(c => c.suit === targetSuit);
    if (!allSameSuit) {
      return false;
    }

    // Check if values can form a sequence (with jokers filling gaps)
    const values = regularCards.map(c => c.value).sort((a, b) => a - b);
    return this.#canFormSequence(values, jokers.length);
  }

  #canFormSequence(sortedValues: number[], jokerCount: number): boolean {
    if (sortedValues.length === 0) {
      return false;
    }

    if (sortedValues.length === 1) {
      return (sortedValues.length + jokerCount) >= 3;
    }

    let jokersNeeded = 0;

    // Count gaps between consecutive regular cards
    for (let i = 1; i < sortedValues.length; i++) {
      const gap = sortedValues[i] - sortedValues[i - 1] - 1;

      // Duplicate or descending values - invalid
      if (gap < 0) {
        return false;
      }

      // Add to jokers needed to fill this gap
      jokersNeeded += gap;

      // Not enough jokers to fill all gaps
      if (jokersNeeded > jokerCount) {
        return false;
      }
    }

    return true;
  }

  #calculateTotalMeldScore(melds: Card[][]): number {
    return melds.reduce((sum, meld) => sum + this.#calculateMeldValue(meld), 0);
  }


  #createEmptyValidation(selectedCards: Card[]): MeldValidationResult {
    return {
      selectedCards,
      validMelds: [],
      invalidCards: selectedCards,
      totalScore: 0,
      meldScores: [],
      meetsOpenRequirement: false,
      minimumNeeded: 51,
      hasOpened: false
    };
  }

  #calculateMeldValue(meld: Card[]): number {
    return meld.reduce((sum, card) => {
      if (this.#isJoker(card)) {
        return sum + this.#getJokerValueInMeld(card, meld);
      }
      return sum + this.#cardPointValue(card);
    }, 0);
  }

  #getJokerValueInMeld(joker: Card, meld: Card[]): number {
    const regularCards = meld.filter(c => !this.#isJoker(c));
    
    if (regularCards.length === 0) return 0;

    // In a SET: joker takes value of the set
    if (this.#isValidSet(meld)) {
      return this.#cardPointValue(regularCards[0]);
    }

    if (this.#isValidRun(meld)) {
      return this.#getJokerValueInRun(joker, meld, regularCards)
    }
    return 0;
  }

  #getJokerValueInRun(joker: Card, meld: Card[], regularCards: Card[]): number {
    // Sort regular cards by value
    const sortedValues = regularCards.map(c => c.value).sort((a, b) => a - b);
    
    // Build the complete sequence with joker positions marked
    const sequence = this.#buildSequenceWithJokers(meld, sortedValues);
    
    // Find this joker's position in the original meld
    const jokerPositionInMeld = meld.indexOf(joker);
    
    // Get the value at that position in the sequence
    const jokerValue = sequence[jokerPositionInMeld];
    
    // Convert to points
    return this.#cardPointValue({ value: jokerValue } as Card);
  }

  #buildSequenceWithJokers(meld: Card[], sortedValues: number[]): number[] {
    const minValue = sortedValues[0];
    
    // Count leading jokers (before first regular card)
    let leadingJokers = 0;
    for (const card of meld) {
      if (this.#isJoker(card)) {
        leadingJokers++;
      } else {
        break; // Found first regular card
      }
    }
    
    const startValue = minValue - leadingJokers;
    
    // Build sequence
    const sequence: number[] = [];
    let currentValue = startValue;
    
    for (let i = 0; i < meld.length; i++) {
      sequence.push(currentValue);
      currentValue++;
    }
    
    return sequence;
  }

  #cardPointValue(card: Card): number {
    if (card.value === 1) return 10; // Ace
    if (card.value >= 2 && card.value <= 10) return card.value;
    if (card.value >= 11 && card.value <= 13) return 10; // Face
    if (card.value === 14) return 0; // Joker (handled separately)
    return 0;
  }

  #canCardsBeAdjacent(card1: Card, card2: Card): boolean {
    // Rule: Cannot have adjacent jokers in selection
    if (this.#isJoker(card1) && this.#isJoker(card2)) {
      return false;
    }
    return true;
  }

  #isJoker(card: Card): boolean {
    return card.suit === "JOKER_RED" ||
      card.suit === "JOKER_BLACK" ||
      card.value === 14;
  }
}