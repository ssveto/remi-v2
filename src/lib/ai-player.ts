// =============================================================================
// ai-player.ts - AI Decision Making Logic
// =============================================================================
// This file contains ALL AI logic separate from game logic and visuals.
// The AI uses the same public API as human players - no special privileges!
// =============================================================================

import type { Card } from "./card";
import type { Remi } from "./remi";

/**
 * AI difficulty levels.
 * WHY: Different strategies for different skill levels.
 */
export enum AIDifficulty {
  EASY = "EASY",      // Random decisions, poor strategy
  MEDIUM = "MEDIUM",  // Some strategy, makes occasional mistakes
  HARD = "HARD",      // Good strategy, optimal play
}

/**
 * Configuration for AI behavior.
 */
export interface AIConfig {
  difficulty: AIDifficulty;
  thinkDelay: number; // Milliseconds to "think" before acting
  randomness: number; // 0-1, how much randomness to add to decisions
}

/**
 * AI Player - makes decisions for computer-controlled players.
 * 
 * ARCHITECTURE:
 * - Uses ONLY public API from Remi (same as human players)
 * - Pure decision-making logic - no side effects
 * - Returns recommendations that game scene executes
 * - Completely testable without Phaser or game state
 */
export class AIPlayer {
  private config: AIConfig;
  
  constructor(config: AIConfig = {
    difficulty: AIDifficulty.MEDIUM,
    thinkDelay: 800,
    randomness: 0.2,
  }) {
    this.config = config;
  }
  
  // -------------------------------------------------------------------------
  // PUBLIC API: Decision Making
  // -------------------------------------------------------------------------
  
  /**
   * Decide whether to draw from discard pile or draw pile.
   * 
   * @param logic - Game logic instance (for read-only access)
   * @param playerIndex - Which AI player is making decision
   * @returns true to draw from discard, false to draw from deck
   */
  public shouldDrawFromDiscard(logic: Remi, playerIndex: number): boolean {
    const state = logic.getState();
    
    // Can't draw from empty discard pile
    if (state.discardPileSize === 0 || !state.topDiscardCard) {
      return false;
    }
    
    const hand = logic.getPlayerHand(playerIndex);
    const discardCard = state.topDiscardCard;
    
    // Easy AI: Random decision
    if (this.config.difficulty === AIDifficulty.EASY) {
      return Math.random() < 0.3; // 30% chance to take discard
    }
    
    // Medium/Hard AI: Strategic decision
    return this.evaluateDiscardCardValue(hand, discardCard);
  }
  
  /**
   * Find best melds to lay down.
   * 
   * @param logic - Game logic instance
   * @param playerIndex - Which AI player
   * @returns Array of melds to lay, or empty array if none good enough
   */
  public findMeldsToLayDown(logic: Remi, playerIndex: number): Card[][] {
    const hand = logic.getPlayerHand(playerIndex);
    const hasOpened = logic.hasPlayerOpened(playerIndex);
    
    // Easy AI: Just find first valid meld
    if (this.config.difficulty === AIDifficulty.EASY) {
      const firstMeld = this.findFirstValidMeld(hand);
      if (!firstMeld) return [];
      
      // Check if it meets opening requirement
      const validation = logic.validateMelds(playerIndex, hand);
      if (!hasOpened && validation.totalScore < 51) {
        return [];
      }
      
      return [firstMeld];
    }
    
    // Medium/Hard AI: Find optimal combination
    const bestCombination = this.findBestMeldCombination(hand, logic, playerIndex);
    
    // Check if worth laying down
    if (!hasOpened && bestCombination.score < 51) {
      return [];
    }
    
    // Hard AI: Always lay down valid melds
    if (this.config.difficulty === AIDifficulty.HARD) {
      return bestCombination.melds;
    }
    
    // Medium AI: Sometimes holds back melds for better combinations
    if (bestCombination.score < 70 && Math.random() < 0.3) {
      return []; // Hold back
    }
    
    return bestCombination.melds;
  }
  
  /**
   * Select which card to discard.
   * 
   * @param logic - Game logic instance
   * @param playerIndex - Which AI player
   * @returns Card to discard
   */
  public selectCardToDiscard(logic: Remi, playerIndex: number): Card {
    const hand = logic.getPlayerHand(playerIndex);
    
    // Easy AI: Random discard
    if (this.config.difficulty === AIDifficulty.EASY) {
      return hand[Math.floor(Math.random() * hand.length)];
    }
    
    // Medium/Hard AI: Strategic discard
    return this.findLeastValuableCard(hand);
  }
  
  /**
   * Execute a full AI turn.
   * 
   * WHY: Convenience method that makes all decisions for a turn.
   * Returns array of actions to execute (for game scene to perform).
   */
  public planTurn(logic: Remi, playerIndex: number): AITurnPlan {
    const plan: AITurnPlan = {
      drawFromDiscard: false,
      meldsToLay: [],
      cardToDiscard: null,
    };
    
    // Step 1: Draw decision
    plan.drawFromDiscard = this.shouldDrawFromDiscard(logic, playerIndex);
    
    // Note: We can't actually see the drawn card yet, so meld planning
    // happens AFTER the draw in the game scene
    
    return plan;
  }
  
  /**
   * Plan meld and discard after drawing.
   * WHY: Called after draw to see what melds are possible with new card.
   */
  public planMeldAndDiscard(logic: Remi, playerIndex: number): {
    meldsToLay: Card[][];
    cardToDiscard: Card;
  } {
    const meldsToLay = this.findMeldsToLayDown(logic, playerIndex);
    
    // Get updated hand after laying melds (simulate it)
    const hand = logic.getPlayerHand(playerIndex);
    const cardsToRemove = new Set(meldsToLay.flat());
    const remainingHand = hand.filter(c => !cardsToRemove.has(c));
    
    // Find card to discard from remaining hand
    const cardToDiscard = remainingHand.length > 0
      ? this.findLeastValuableCard(remainingHand)
      : hand[0]; // Fallback
    
    return { meldsToLay, cardToDiscard };
  }
  
  // -------------------------------------------------------------------------
  // PRIVATE: Strategic Evaluation
  // -------------------------------------------------------------------------
  
  /**
   * Evaluate if taking discard card is beneficial.
   */
  private evaluateDiscardCardValue(hand: Card[], discardCard: Card): boolean {
    // Don't take if hand is full
    if (hand.length >= 14) return false;
    
    // Strategy 1: Does it complete a meld immediately?
    const testHand = [...hand, discardCard];
    if (this.wouldCompleteMeld(testHand)) {
      return true;
    }
    
    // Strategy 2: Does it get us closer to a meld?
    if (this.cardGetsCloserToMeld(hand, discardCard)) {
      // Medium AI: 60% chance to take
      // Hard AI: Always take
      return this.config.difficulty === AIDifficulty.HARD 
        ? true 
        : Math.random() < 0.6;
    }
    
    // Strategy 3: Is it a valuable card (joker, ace, face)?
    const isValuable = this.isJoker(discardCard) 
      || discardCard.value === 1 
      || discardCard.value >= 10;
    
    if (isValuable) {
      // Take valuable cards sometimes
      return Math.random() < (this.config.difficulty === AIDifficulty.HARD ? 0.7 : 0.4);
    }
    
    return false;
  }
  
  /**
   * Check if adding card would immediately complete a meld.
   */
  private wouldCompleteMeld(hand: Card[]): boolean {
    // Simple check: look for 3+ of same value or 3+ consecutive same suit
    
    // Check sets
    const valueCounts = new Map<number, number>();
    hand.forEach(card => {
      if (!this.isJoker(card)) {
        valueCounts.set(card.value, (valueCounts.get(card.value) || 0) + 1);
      }
    });
    
    for (const count of valueCounts.values()) {
      if (count >= 3) return true;
    }
    
    // Check runs (simplified)
    const suitGroups = new Map<string, Card[]>();
    hand.forEach(card => {
      if (!this.isJoker(card)) {
        if (!suitGroups.has(card.suit)) {
          suitGroups.set(card.suit, []);
        }
        suitGroups.get(card.suit)!.push(card);
      }
    });
    
    for (const cards of suitGroups.values()) {
      if (cards.length >= 3) {
        cards.sort((a, b) => a.value - b.value);
        // Check for consecutive values
        for (let i = 0; i <= cards.length - 3; i++) {
          if (cards[i + 1].value === cards[i].value + 1 &&
              cards[i + 2].value === cards[i + 1].value + 1) {
            return true;
          }
        }
      }
    }
    
    return false;
  }
  
  /**
   * Check if card gets closer to forming a meld.
   */
  private cardGetsCloserToMeld(hand: Card[], newCard: Card): boolean {
    // Check for potential sets (2 of same value)
    const sameValueCount = hand.filter(c =>
      !this.isJoker(c) && !this.isJoker(newCard) && c.value === newCard.value
    ).length;
    
    if (sameValueCount >= 1) return true;
    
    // Check for potential runs (cards within 2 of each other in same suit)
    const sameSuitCards = hand.filter(c =>
      !this.isJoker(c) && c.suit === newCard.suit
    );
    
    for (const card of sameSuitCards) {
      const diff = Math.abs(card.value - newCard.value);
      if (diff <= 2 && diff >= 1) return true;
    }
    
    return false;
  }
  
  /**
   * Find first valid meld (for easy AI).
   */
  private findFirstValidMeld(hand: Card[]): Card[] | null {
    // Try to find any set of 3
    for (let i = 0; i < hand.length - 2; i++) {
      for (let j = i + 1; j < hand.length - 1; j++) {
        for (let k = j + 1; k < hand.length; k++) {
          const testMeld = [hand[i], hand[j], hand[k]];
          if (this.isValidSet(testMeld) || this.isValidRun(testMeld)) {
            return testMeld;
          }
        }
      }
    }
    
    return null;
  }
  
  /**
   * Find best combination of melds.
   */
  private findBestMeldCombination(
    hand: Card[], 
    logic: Remi,
    playerIndex: number
  ): { melds: Card[][], score: number } {
    // Use logic layer to find all possible melds
    const validation = logic.validateMelds(playerIndex, hand);
    
    return {
      melds: validation.validMelds,
      score: validation.totalScore,
    };
  }
  
  /**
   * Find least valuable card to discard.
   */
  private findLeastValuableCard(hand: Card[]): Card {
    const cardScores = hand.map(card => ({
      card,
      score: this.evaluateCardKeepValue(card, hand),
    }));
    
    // Sort by score (lowest = least useful)
    cardScores.sort((a, b) => a.score - b.score);
    
    // Add some randomness for medium difficulty
    if (this.config.difficulty === AIDifficulty.MEDIUM && Math.random() < this.config.randomness) {
      // Sometimes pick a random card from bottom 3
      const worstCards = cardScores.slice(0, Math.min(3, cardScores.length));
      return worstCards[Math.floor(Math.random() * worstCards.length)].card;
    }
    
    return cardScores[0].card;
  }
  
  /**
   * Evaluate how valuable a card is to keep.
   */
  private evaluateCardKeepValue(card: Card, hand: Card[]): number {
    let score = 0;
    
    // Jokers are always valuable
    if (this.isJoker(card)) return 1000;
    
    // Check how many cards of same value we have (potential set)
    const sameValue = hand.filter(c =>
      !this.isJoker(c) && c !== card && c.value === card.value
    ).length;
    score += sameValue * 30;
    
    // Check how many cards of same suit nearby (potential run)
    const sameSuitNearby = hand.filter(c =>
      !this.isJoker(c) &&
      c !== card &&
      c.suit === card.suit &&
      Math.abs(c.value - card.value) <= 2
    ).length;
    score += sameSuitNearby * 25;
    
    // Aces and face cards are more valuable
    if (card.value === 1 || card.value >= 10) {
      score += 15;
    }
    
    // Middle value cards (5-9) are more versatile for runs
    if (card.value >= 5 && card.value <= 9) {
      score += 10;
    }
    
    // Penalty for high point value
    score -= this.cardPointValue(card) * 0.5;
    
    return score;
  }
  
  // -------------------------------------------------------------------------
  // PRIVATE: Card Validation Helpers
  // -------------------------------------------------------------------------
  
  private isJoker(card: Card): boolean {
    return card.suit === "JOKER_RED" || 
           card.suit === "JOKER_BLACK" || 
           card.value === 14;
  }
  
  private cardPointValue(card: Card): number {
    if (card.value === 1) return 10; // Ace
    if (card.value >= 11 && card.value <= 13) return 10; // Face
    if (card.value === 14) return 0; // Joker
    return card.value;
  }
  
  private isValidSet(cards: Card[]): boolean {
    if (cards.length < 3 || cards.length > 4) return false;
    
    const jokers = cards.filter(c => this.isJoker(c));
    const regular = cards.filter(c => !this.isJoker(c));
    
    if (jokers.length > 1) return false;
    if (regular.length === 0) return false;
    
    const value = regular[0].value;
    if (!regular.every(c => c.value === value)) return false;
    
    const suits = new Set(regular.map(c => c.suit));
    return suits.size === regular.length;
  }
  
  private isValidRun(cards: Card[]): boolean {
    if (cards.length < 3) return false;
    
    const jokers = cards.filter(c => this.isJoker(c));
    const regular = cards.filter(c => !this.isJoker(c));
    
    if (jokers.length > 1) return false;
    if (regular.length === 0) return false;
    
    const suit = regular[0].suit;
    if (!regular.every(c => c.suit === suit)) return false;
    
    const values = regular.map(c => c.value).sort((a, b) => a - b);
    
    // Check if values can form sequence with jokers
    let jokersNeeded = 0;
    for (let i = 1; i < values.length; i++) {
      const gap = values[i] - values[i - 1] - 1;
      if (gap < 0) return false;
      jokersNeeded += gap;
      if (jokersNeeded > jokers.length) return false;
    }
    
    return true;
  }
}

/**
 * Plan for an AI turn.
 * WHY: Encapsulates all decisions so game scene can execute them.
 */
export interface AITurnPlan {
  drawFromDiscard: boolean;
  meldsToLay: Card[][];
  cardToDiscard: Card | null; // Set after draw
}