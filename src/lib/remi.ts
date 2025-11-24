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

    const sortedMelds = melds.map(meld => this.#sortMeldForDisplay(meld));

    // Execute: Remove from hand, add to table
    sortedMelds.flat().forEach(card => {
      const idx = hand.indexOf(card);
      if (idx > -1) hand.splice(idx, 1);
    });
    this.#playerMelds[playerIndex].push(...sortedMelds);

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
      melds: sortedMelds,
      meldScore: totalScore,
      playerHasOpened: this.#playersHaveOpened[playerIndex],

    });

    return true;
  }

  #sortMeldForDisplay(meld: Card[]): Card[] {
    // Check if it's a run (needs sorting)
    if (this.#isValidRun(meld)) {
      return this.#sortRunCards(meld);
    }
    // Sets don't need sorting, return as-is
    return meld;
  }

  public addCardToMeld(
    playerIndex: number,
    card: Card,
    meldOwner: number,
    meldIndex: number,
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

    // Check if we can replace a joker
    let replacedJoker: Card | null = null;
    const jokerIndex = meld.findIndex(c => this.#isJoker(c));

    if (jokerIndex !== -1) {
      const joker = meld[jokerIndex];

      // Try replacing the joker with the new card
      const meldWithReplacement = [...meld];
      meldWithReplacement[jokerIndex] = card;

      // Check if the meld is still valid after replacement
      if (this.#isValidSet(meldWithReplacement) || this.#isValidRun(meldWithReplacement)) {
        // Valid replacement! Check if this card specifically replaces the joker
        if (this.#doesCardReplaceJoker(card, joker, meld)) {
          replacedJoker = joker;

          // Execute replacement: remove card from hand, replace joker in meld
          const idx = hand.indexOf(card);
          hand.splice(idx, 1);
          meld[jokerIndex] = card;

          // Give joker back to player
          hand.push(replacedJoker);

          // Emit
          this.#events.emit({
            type: GameEventType.CARD_ADDED_TO_MELD,
            timestamp: Date.now(),
            playerIndex,
            card,
            meldIndex,
            meldOwner,  // Add this
            replacedJoker,
          });

          return true;
        }
      }
    }

    // No joker replacement - just add the card normally
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
      meldOwner,
      replacedJoker: null,
    });

    return true;
  }

  #doesCardReplaceJoker(card: Card, joker: Card, meld: Card[]): boolean {
    // Find joker position in meld
    const jokerIndex = meld.indexOf(joker);
    if (jokerIndex === -1) return false;

    // Determine if this is a set or run
    const regularCards = meld.filter(c => !this.#isJoker(c));

    if (regularCards.length === 0) return false;

    // Check if it's a SET
    const allSameValue = regularCards.every(c => c.value === regularCards[0].value);
    const allDifferentSuits = new Set(regularCards.map(c => c.suit)).size === regularCards.length;

    if (allSameValue && allDifferentSuits) {
      // This is a SET
      // RULE: Joker can only be replaced when completing the 4th card of a set
      // Current meld has: regularCards.length regular cards + 1 joker
      // After adding the new card, we'll have: regularCards.length + 1 regular cards + 1 joker

      // The joker can only be replaced if:
      // 1. The current meld already has 3 regular cards (so adding 4th completes the set)
      // 2. The new card has the same value but different suit

      if (regularCards.length < 3) {
        // Not enough cards yet - joker stays in the meld
        return false;
      }

      // We have 3+ regular cards, check if the new card completes the set
      const isCorrectValue = card.value === regularCards[0].value;
      const isUniqueSuit = !regularCards.some(c => c.suit === card.suit);
      return isCorrectValue && isUniqueSuit;
    }

    // Check if it's a RUN
    const allSameSuit = regularCards.every(c => c.suit === regularCards[0].suit);

    if (allSameSuit) {
      // This is a RUN - determine what value the joker represents
      const jokerRepresentsValue = this.#getJokerRepresentedValueInRun(joker, meld);

      // The card replaces the joker if it's the right suit and right value
      const isCorrectSuit = card.suit === regularCards[0].suit;
      const isCorrectValue = card.value === jokerRepresentsValue;

      return isCorrectSuit && isCorrectValue;
    }

    return false;
  }

  #getJokerRepresentedValueInRun(joker: Card, meld: Card[]): number {
    const regularCards = meld.filter(c => !this.#isJoker(c));
    const sortedValues = regularCards.map(c => c.value).sort((a, b) => a - b);

    // Build the complete sequence
    const sequence = this.#buildSequenceWithJokers(meld, sortedValues);

    // Find joker's position and return its value
    const jokerPositionInMeld = meld.indexOf(joker);
    return sequence[jokerPositionInMeld];
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

    if (cards.length < 3) return validMelds;

    let i = 0;

    while (i < cards.length) {
      let currentGroup: Card[] = [cards[i]];
      let j = i + 1;

      // 1. Greedily build the longest possible contiguous sequence
      while (j < cards.length) {
        const lastCardInGroup = currentGroup[currentGroup.length - 1];
        const nextCardInArray = cards[j];

        if (this.#canCardsBeAdjacent(lastCardInGroup, nextCardInArray)) {
          currentGroup.push(nextCardInArray);
          j++;
        } else {
          break;
        }
      }

      // 2. Try multiple split points (not just removing last card)
      let bestSplit = null;

      if (currentGroup.length >= 6) {
        // Try all possible split points that leave at least 3 cards on each side
        for (let splitPoint = 3; splitPoint <= currentGroup.length - 3; splitPoint++) {
          const meldCandidate = currentGroup.slice(0, splitPoint);

          if (this.#isValidMeld(meldCandidate)) {
            const remainderStartIndex = i + splitPoint;
            const remainder = cards.slice(remainderStartIndex);

            const remainingMelds = this.#splitIntoMeldGroups(remainder);

            if (remainingMelds.length > 0) {
              // Found a valid split! Save it
              bestSplit = {
                meldCandidate,
                remainingMelds,
                remainderStartIndex
              };
              break; // Use first valid split found
            }
          }
        }
      }

      // 3. If we found a valid split, use it
      if (bestSplit) {
        validMelds.push(bestSplit.meldCandidate);
        validMelds.push(...bestSplit.remainingMelds);

        const cardsUsedInRemainder = bestSplit.remainingMelds.reduce(
          (total, meld) => total + meld.length,
          0
        );

        i = bestSplit.remainderStartIndex + cardsUsedInRemainder;
        continue;
      }

      // 4. Fallback: Use the full greedy group if it's valid
      if (currentGroup.length >= 3 && this.#isValidMeld(currentGroup)) {
        validMelds.push(currentGroup);
        i = j;
      } else {
        // Not a valid meld, advance by one card
        i++;
      }
    }

    return validMelds;
  }
  // #evaluateGroup(group: Card[]): {
  //   isValid: boolean;
  //   validSubgroup: Card[] | null;
  // } {
  //   if (this.#isValidMeld(group)) {
  //     return { isValid: true, validSubgroup: null };
  //   }

  //   // Group is invalid - check if removing last card makes it valid
  //   if (group.length > 3) {
  //     const withoutLast = group.slice(0, -1);
  //     if (withoutLast.length >= 3 && this.#isValidMeld(withoutLast)) {
  //       return { isValid: false, validSubgroup: withoutLast };
  //     }
  //   }

  //   return { isValid: false, validSubgroup: null };
  // }


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

  //
  #isValidRun(cards: Card[]): boolean {
    if (cards.length < 3) return false;

    // 1. Separate regular cards to check suits
    const regularCards = cards.filter(c => !this.#isJoker(c));
    
    // Allow runs of pure jokers (e.g. 3 jokers)
    if (regularCards.length === 0) return false; 

    // 2. Suit Check: All regular cards must be same suit
    const targetSuit = regularCards[0].suit;
    if (!regularCards.every(c => c.suit === targetSuit)) return false;

    // 3. Sort cards by value before validation
    // Keep jokers in their relative positions, but sort regular cards
    const sortedCards = this.#sortRunCards(cards);

    // 4. Positional Gap Check (on sorted cards)
    return this.#validatePositionalRun(sortedCards);
}

#sortRunCards(cards: Card[]): Card[] {
    // Create array with indices to track joker positions
    const indexed = cards.map((card, index) => ({
        card,
        originalIndex: index,
        isJoker: this.#isJoker(card)
    }));

    // Separate jokers and regular cards
    const jokers = indexed.filter(item => item.isJoker);
    const regulars = indexed.filter(item => !item.isJoker);

    // Sort regular cards by value
    regulars.sort((a, b) => {
        // Handle Ace - check if we need high ace (with high cards) or low ace
        const hasHighCards = regulars.some(r => r.card.value >= 11);
        const aVal = a.card.value === 1 && hasHighCards ? 14 : a.card.value;
        const bVal = b.card.value === 1 && hasHighCards ? 14 : b.card.value;
        return aVal - bVal;
    });

    // Now we need to interleave jokers back in logical positions
    // Strategy: Place jokers to fill gaps between regular cards
    const result: Card[] = [];
    let jokerIdx = 0;

    for (let i = 0; i < regulars.length; i++) {
        const current = regulars[i].card;
        const next = regulars[i + 1]?.card;

        result.push(current);

        if (next) {
            // Calculate gap between current and next card
            const currentVal = current.value === 1 && next.value >= 11 ? 14 : current.value;
            const nextVal = next.value === 1 && current.value >= 11 ? 14 : next.value;
            const gap = nextVal - currentVal - 1;

            // Insert jokers to fill the gap
            const jokersToInsert = Math.min(gap, jokers.length - jokerIdx);
            for (let j = 0; j < jokersToInsert; j++) {
                result.push(jokers[jokerIdx++].card);
            }
        }
    }

    // Add any remaining jokers at the end
    while (jokerIdx < jokers.length) {
        result.push(jokers[jokerIdx++].card);
    }

    return result;
}

  /**
   * Validates that the EXACT sequence provided by the player is valid.
   * Rule: Rank(Next) - Rank(Current) == NumJokersInBetween + 1
   */
  #validatePositionalRun(cards: Card[]): boolean {
    // Filter out jokers but keep their original indices to calculate gaps
    const indexedRegulars = cards
      .map((card, index) => ({ card, index, isJoker: this.#isJoker(card) }))
      .filter(item => !item.isJoker);

    // If 0 or 1 regular card, it's valid (e.g., J-Joker-Joker or Joker-5-Joker)
    if (indexedRegulars.length < 2) return true;

    // We need to determine if this is an Ascending or Descending run based on the first gap
    // However, A-2-3 and Q-K-A are both valid, so we must be careful with Ace.
    let isAscending: boolean | null = null;

    for (let i = 0; i < indexedRegulars.length - 1; i++) {
      const current = indexedRegulars[i];
      const next = indexedRegulars[i + 1];

      // "N" is the number of jokers physically sitting between these two cards
      const jokersBetween = next.index - current.index - 1;
      const requiredGap = jokersBetween + 1;

      const v1 = current.card.value;
      const v2 = next.card.value;

      // --- CHECK 1: Try Standard Low Ace (Ace=1) ---
      let diff = v2 - v1;
      let validStep = false;
      let stepDirectionIsAscending = true;

      if (Math.abs(diff) === requiredGap) {
        validStep = true;
        stepDirectionIsAscending = diff > 0;
      }

      // --- CHECK 2: Try High Ace (Ace=14) if standard failed ---
      // We only try this if one of the cards is an Ace (1)
      if (!validStep && (v1 === 1 || v2 === 1)) {
        const v1High = v1 === 1 ? 14 : v1;
        const v2High = v2 === 1 ? 14 : v2;
        const diffHigh = v2High - v1High;

        if (Math.abs(diffHigh) === requiredGap) {
          validStep = true;
          stepDirectionIsAscending = diffHigh > 0;
        }
      }

      if (!validStep) return false; // Gap is wrong (e.g. Q..Joker..J)

      // --- CHECK 3: Enforce Monotonicity (Must allow 12-13-1 but not 12-13-12) ---
      if (isAscending === null) {
        isAscending = stepDirectionIsAscending;
      } else if (isAscending !== stepDirectionIsAscending) {
        return false; // Changed direction (e.g. 5 -> 6 -> 5)
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
    let startValue;
    if (sortedValues[0] === 1 && sortedValues[sortedValues.length - 1] > 10) {
      startValue = 14 - meld.length + 1;
    } else {
      startValue = minValue - leadingJokers;
    }

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
    // 1. Explicitly handle the physical Joker card first
    // Checks suit OR value 14, depending on how your Card class constructs Jokers
    if (this.#isJoker(card)) {
      return 0; // Or whatever base value a Joker has in hand (usually 0 or 25 depending on rules)
      // Note: In a meld, this function isn't called for the Joker itself; 
      // #getJokerValueInMeld calculates the value it *represents*.
    }

    // 2. Handle Regular Cards
    if (card.value === 1) return 10; // Low Ace (always 10 pts in Rummy usually)
    if (card.value >= 2 && card.value <= 10) return card.value;
    if (card.value >= 11 && card.value <= 13) return 10; // K, Q, J

    // 3. Handle Virtual High Ace
    // This case is only hit if you manually construct a virtual card 
    // object with value 14 inside #getJokerValueInRun
    if (card.value === 14) return 10;

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
      card.suit === "JOKER_BLACK";
  }
}