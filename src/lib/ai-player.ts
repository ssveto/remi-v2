import { Remi } from "./remi";
import { Card } from "./card";

export enum AIDifficulty {
  EASY = "EASY",
  MEDIUM = "MEDIUM",
  HARD = "HARD",
}

export interface AIConfig {
  difficulty: AIDifficulty;
  thinkDelay: number;
  randomness: number;
}

interface MeldCandidate {
  cards: Card[];
  score: number;
  type: 'RUN' | 'SET';
  efficiency: number; // Points per card
}

interface HandSolution {
  melds: Card[][];
  remainingCards: Card[];
  totalScore: number;
  deadwoodValue: number; // Total point value of remaining cards
}

interface OpponentModel {
  knownDiscards: Card[];
  estimatedDeadwood: number;
  hasOpened: boolean;
  recentDraws: ('deck' | 'discard')[];
}

export class AIPlayer {
  private config: AIConfig;
  private opponentModels: Map<number, OpponentModel> = new Map();

  constructor(config: AIConfig) {
    this.config = config;
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  public shouldDrawFromDiscard(logic: Remi, playerIndex: number): boolean {
    const state = logic.getState();
    const topDiscard = state.topDiscardCard;
    
    if (!topDiscard || state.discardPileSize === 0) return false;

    const hand = logic.getPlayerHand(playerIndex);
    const hasOpened = logic.hasPlayerOpened(playerIndex);
    
    // Easy AI: Only take if it immediately completes a meld
    if (this.config.difficulty === AIDifficulty.EASY) {
      return this.wouldCompleteImmediate(topDiscard, hand, hasOpened);
    }

    // Evaluate current vs new hand
    const currentSolution = this.solveHand(hand);
    const simulatedHand = [...hand, topDiscard];
    const newSolution = this.solveHand(simulatedHand);

    // Medium/Hard: Consider multiple factors
    const scoreImprovement = newSolution.totalScore - currentSolution.totalScore;
    const deadwoodReduction = currentSolution.deadwoodValue - newSolution.deadwoodValue;
    const synergy = this.evaluateCardSynergy(topDiscard, hand);

    // Hard AI: Also consider opponent behavior
    if (this.config.difficulty === AIDifficulty.HARD) {
      const opponentWantsCard = this.estimateOpponentInterest(topDiscard, state);
      if (opponentWantsCard && synergy > 15) {
        return true; // Defensive play: deny opponent useful cards
      }
    }

    // Decision thresholds by difficulty
    const thresholds = {
      [AIDifficulty.EASY]: { score: 10, synergy: 30 },
      [AIDifficulty.MEDIUM]: { score: 5, synergy: 20, deadwood: 5 },
      [AIDifficulty.HARD]: { score: 3, synergy: 15, deadwood: 3 },
    };

    const threshold = thresholds[this.config.difficulty];

    // Take if significant improvement
    if (scoreImprovement >= threshold.score) return true;
    if (deadwoodReduction >= (threshold.deadwood || 0)) return true;
    if (synergy >= threshold.synergy) return true;

    // Add controlled randomness for unpredictability
    if (Math.random() < this.config.randomness && synergy > 10) {
      return true;
    }

    return false;
  }

  public planMeldAndDiscard(logic: Remi, playerIndex: number): {
    meldsToLay: Card[][];
    cardToDiscard: Card;
  } {
    const hand = logic.getPlayerHand(playerIndex);
    const hasOpened = logic.hasPlayerOpened(playerIndex);
    const state = logic.getState();
    
    // 1. Solve Hand
    const solution = this.solveHand(hand);
    
    let meldsToLay: Card[][] = [];

    // 2. Validate melds strictly
    const validMelds = solution.melds.filter(meld => 
      this.isValidSet(meld) || this.isValidRun(meld)
    );

    // 3. Decide whether to lay down melds
    if (validMelds.length > 0) {
      if (hasOpened) {
        // Already opened: lay down everything valid
        meldsToLay = validMelds;
      } else {
        // Not opened: check if we meet the 51-point requirement
        const totalScore = validMelds.reduce((sum, m) => sum + this.calcScore(m), 0);
        
        if (totalScore >= 51) {
          meldsToLay = validMelds;
        } else if (this.config.difficulty === AIDifficulty.HARD) {
          // Hard AI: Consider holding back if close to winning
          const remainingAfterMelds = hand.filter(c => 
            !validMelds.flat().some(mc => mc.id === c.id)
          );
          const remainingDeadwood = this.calculateDeadwood(remainingAfterMelds);
          
          // If we're very close to going out, might want to wait
          if (remainingDeadwood <= 10 && remainingAfterMelds.length <= 3) {
            // Hold melds, try to go out next turn
            meldsToLay = [];
          }
        }
      }
    }



   //Order cards properly in each meld before laying them down
    meldsToLay = meldsToLay.map(meld => this.orderCardsInMeld(meld));


    // 4. Determine discard
    const usedCardIds = new Set(meldsToLay.flat().map(c => c.id));
    const cardsAvailableToDiscard = hand.filter(c => !usedCardIds.has(c.id));

    let cardToDiscard: Card;

    if (cardsAvailableToDiscard.length === 0) {
      // Edge case: must break a meld to discard
      cardToDiscard = this.selectCardFromMelds(meldsToLay, hand);
    } else {
      cardToDiscard = this.selectBestDiscard(
        cardsAvailableToDiscard, 
        state,
        playerIndex,
        logic
      );
    }

    return { meldsToLay, cardToDiscard };
  }

  // =========================================================================
  // SOLVER LOGIC (Improved)
  // =========================================================================

  private solveHand(hand: Card[]): HandSolution {
    const candidates = this.findAllCandidates(hand);
    
    // Sort by efficiency (points per card) for better optimization
    candidates.sort((a, b) => {
      if (b.efficiency !== a.efficiency) return b.efficiency - a.efficiency;
      return b.score - a.score;
    });

    const solution = this.findBestCombination(candidates, hand, [], 0, 0);
    
    // Calculate deadwood value
    const deadwoodValue = this.calculateDeadwood(solution.remainingCards);
    
    return {
      ...solution,
      deadwoodValue
    };
  }

  private findBestCombination(
    candidates: MeldCandidate[],
    availableCards: Card[],
    chosenMelds: Card[][],
    currentScore: number,
    depth: number
  ): HandSolution {
    // Prevent infinite recursion
    if (depth > 20) {
      return {
        melds: chosenMelds,
        remainingCards: availableCards,
        totalScore: currentScore,
        deadwoodValue: this.calculateDeadwood(availableCards)
      };
    }

    let bestSolution: HandSolution = {
      melds: chosenMelds,
      remainingCards: availableCards,
      totalScore: currentScore,
      deadwoodValue: this.calculateDeadwood(availableCards)
    };

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];

      if (this.canMakeMeld(candidate.cards, availableCards)) {
        const remainingAfterMeld = this.removeCards(availableCards, candidate.cards);
        const newMelds = [...chosenMelds, candidate.cards];
        const newScore = currentScore + candidate.score;

        const subResult = this.findBestCombination(
          candidates.slice(i + 1), 
          remainingAfterMeld,
          newMelds,
          newScore,
          depth + 1
        );

        // Prefer solutions with higher score AND lower deadwood
        const isBetter = 
          subResult.totalScore > bestSolution.totalScore ||
          (subResult.totalScore === bestSolution.totalScore && 
           subResult.deadwoodValue < bestSolution.deadwoodValue);

        if (isBetter) {
          bestSolution = subResult;
        }
      }
    }

    return bestSolution;
  }

  // =========================================================================
  // CANDIDATE GENERATOR (Enhanced)
  // =========================================================================

  private findAllCandidates(hand: Card[]): MeldCandidate[] {
    const candidates: MeldCandidate[] = [];
    const jokers = hand.filter(c => this.isJoker(c));
    const regulars = hand.filter(c => !this.isJoker(c));

    // --- 1. SETS ---
    this.generateSetCandidates(regulars, jokers, candidates);

    // --- 2. RUNS ---
    this.generateRunCandidates(regulars, jokers, candidates);

    // Remove duplicates and calculate efficiency
    return this.deduplicateAndScore(candidates);
  }

  private generateSetCandidates(
    regulars: Card[], 
    jokers: Card[], 
    candidates: MeldCandidate[]
  ): void {
    const byValue = new Map<number, Card[]>();
    regulars.forEach(c => {
      if (!byValue.has(c.value)) byValue.set(c.value, []);
      byValue.get(c.value)!.push(c);
    });

    byValue.forEach((cards) => {
      const distinct = this.filterUniqueSuits(cards);
      
      // Pure sets (3 and 4 cards)
      for (const size of [3, 4]) {
        if (distinct.length >= size) {
          this.getCombinations(distinct, size).forEach(combo => {
            if (this.isValidSet(combo)) {
              const score = this.calcScore(combo);
              candidates.push({ 
                cards: combo, 
                score, 
                type: 'SET',
                efficiency: score / combo.length 
              });
            }
          });
        }
      }

      // Sets with 1 joker (only if we have jokers)
      if (jokers.length > 0) {
        for (const size of [2, 3]) {
          if (distinct.length >= size) {
            this.getCombinations(distinct, size).forEach(combo => {
              const withJoker = [...combo, jokers[0]];
              if (this.isValidSet(withJoker)) {
                const score = this.calcScore(withJoker);
                candidates.push({ 
                  cards: withJoker, 
                  score, 
                  type: 'SET',
                  efficiency: score / withJoker.length 
                });
              }
            });
          }
        }
      }
    });
  }

  private generateRunCandidates(
    regulars: Card[], 
    jokers: Card[], 
    candidates: MeldCandidate[]
  ): void {
    const bySuit = new Map<string, Card[]>();
    regulars.forEach(c => {
      if (!bySuit.has(c.suit)) bySuit.set(c.suit, []);
      bySuit.get(c.suit)!.push(c);
    });

    bySuit.forEach((cards) => {
      cards.sort((a, b) => a.value - b.value);
      
      // Find all possible runs
      for (let len = 3; len <= Math.min(13, cards.length); len++) {
        for (let start = 0; start <= cards.length - len; start++) {
          const subset = cards.slice(start, start + len);
          
          // Check pure run
          if (this.isValidRun(subset)) {
            const score = this.calcScore(subset);
            candidates.push({ 
              cards: subset, 
              score, 
              type: 'RUN',
              efficiency: score / subset.length 
            });
          }

          // Check runs with jokers filling gaps
          if (jokers.length > 0) {
            const values = subset.map(c => c.value);
            const gaps = this.countGapsInValues(values);
            
            if (gaps > 0 && gaps <= jokers.length) {
              const withJokers = [...subset];
              for (let k = 0; k < gaps; k++) {
                withJokers.push(jokers[k]);
              }
              
              if (this.isValidRun(withJokers)) {
                const score = this.calcScore(withJokers);
                candidates.push({ 
                  cards: withJokers, 
                  score, 
                  type: 'RUN',
                  efficiency: score / withJokers.length 
                });
              }
            }
          }
        }
      }
    });
  }

  private deduplicateAndScore(candidates: MeldCandidate[]): MeldCandidate[] {
    // Remove duplicates based on card IDs
    const seen = new Set<string>();
    const unique: MeldCandidate[] = [];

    for (const candidate of candidates) {
      const key = candidate.cards
        .map(c => c.id)
        .sort()
        .join(',');
      
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(candidate);
      }
    }

    return unique;
  }

  // =========================================================================
  // VALIDATION RULES (Mirrors Remi.ts exactly)
  // =========================================================================

  private isValidSet(cards: Card[]): boolean {
    // Must be 3 or 4 cards
    if (cards.length < 3 || cards.length > 4) {
      return false;
    }

    const jokers = cards.filter(c => this.isJoker(c));
    const regularCards = cards.filter(c => !this.isJoker(c));

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
  private isValidRun(cards: Card[]): boolean {
    if (cards.length < 3) return false;

    // 1. Separate regular cards to check suits
    const regularCards = cards.filter(c => !this.isJoker(c));

    // Allow runs of pure jokers (e.g. 3 jokers)
    if (regularCards.length === 0) return false;

    // 2. Suit Check: All regular cards must be same suit
    const targetSuit = regularCards[0].suit;
    if (!regularCards.every(c => c.suit === targetSuit)) return false;

    // 3. Positional Gap Check (Replaces canFormSequence)
    return this.validatePositionalRun(cards);
  }

  /**
   * Validates that the EXACT sequence provided by the player is valid.
   * Rule: Rank(Next) - Rank(Current) == NumJokersInBetween + 1
   */
  private validatePositionalRun(cards: Card[]): boolean {
    // Filter out jokers but keep their original indices to calculate gaps
    const indexedRegulars = cards
      .map((card, index) => ({ card, index, isJoker: this.isJoker(card) }))
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

  // =========================================================================
  // DISCARD STRATEGY (Enhanced with opponent modeling)
  // =========================================================================

  private selectBestDiscard(
    cards: Card[], 
    state: any,
    playerIndex: number,
    logic: Remi
  ): Card {
    const scores = cards.map(card => {
      if (this.isJoker(card)) return { card, score: 9999 };

      let score = 0;
      
      // 1. Deadwood penalty (high-value cards are risky)
      score -= this.getCardPoints(card);
      
      // 2. Synergy bonus (keep cards that work well with others)
      score += this.evaluateCardSynergy(card, cards) * 5;
      
      // 3. Difficulty-based strategy
      if (this.config.difficulty === AIDifficulty.HARD) {
        // Don't give opponents useful cards
        const opponentUtility = this.estimateOpponentInterest(card, state);
        score -= opponentUtility * 3;
        
        // Keep cards that are close to completing melds
        const potentialScore = this.evaluateFuturePotential(card, cards);
        score += potentialScore * 2;
      }

      return { card, score };
    });

    scores.sort((a, b) => a.score - b.score);
    
    // Add slight randomness to avoid predictability
    const topChoices = scores.slice(0, Math.min(3, scores.length));
    const randomIndex = Math.floor(Math.random() * topChoices.length * this.config.randomness);
    
    return topChoices[Math.min(randomIndex, topChoices.length - 1)].card;
  }

  private selectCardFromMelds(melds: Card[][], hand: Card[]): Card {
    // Must break a meld - choose least valuable card
    const allMeldCards = melds.flat();
    const scores = allMeldCards.map(card => ({
      card,
      score: this.getCardPoints(card)
    }));
    
    scores.sort((a, b) => a.score - b.score);
    return scores[0].card;
  }

  // =========================================================================
  // EVALUATION HELPERS
  // =========================================================================

  private wouldCompleteImmediate(card: Card, hand: Card[], hasOpened: boolean): boolean {
    const simulatedHand = [...hand, card];
    const solution = this.solveHand(simulatedHand);
    
    if (!hasOpened) {
      return solution.totalScore >= 51;
    }
    
    return solution.melds.length > 0;
  }

  private evaluateCardSynergy(card: Card, hand: Card[]): number {
    let synergy = 0;
    const regulars = hand.filter(c => !this.isJoker(c) && c.id !== card.id);

    // Set potential (cards with same value)
    const sameValue = regulars.filter(c => c.value === card.value);
    synergy += sameValue.length * 8;

    // Run potential (same suit, nearby values)
    const sameSuit = regulars.filter(c => c.suit === card.suit);
    for (const other of sameSuit) {
      const distance = Math.abs(other.value - card.value);
      if (distance === 1) synergy += 10; // Adjacent
      else if (distance === 2) synergy += 5; // One gap
      else if (distance === 3) synergy += 2; // Two gaps
    }

    return synergy;
  }

  private evaluateFuturePotential(card: Card, hand: Card[]): number {
    // How likely is this card to complete a meld in the future?
    let potential = 0;
    
    const sameValue = hand.filter(c => c.value === card.value && c.id !== card.id);
    potential += sameValue.length * 3;
    
    const sameSuit = hand.filter(c => c.suit === card.suit && c.id !== card.id);
    for (const other of sameSuit) {
      const distance = Math.abs(other.value - card.value);
      if (distance <= 3) potential += (4 - distance);
    }
    
    return potential;
  }

  private estimateOpponentInterest(card: Card, state: any): number {
    // Simple heuristic: avoid giving high-value cards or cards that fit common patterns
    let interest = 0;
    
    // Mid-range cards (5-9) are most useful for runs
    if (card.value >= 5 && card.value <= 9) interest += 5;
    
    // Face cards and aces are useful for sets
    if (card.value === 1 || card.value >= 11) interest += 3;
    
    return interest;
  }

  private calculateDeadwood(cards: Card[]): number {
    return cards.reduce((sum, card) => sum + this.getCardPoints(card), 0);
  }

  // =========================================================================
  // UTILITY METHODS
  // =========================================================================

  private isJoker(card: Card): boolean {
    return card.suit === "JOKER_RED" || card.suit === "JOKER_BLACK";
  }

  private getCardPoints(card: Card): number {
    // 1. Explicitly handle the physical Joker card first
    // Checks suit OR value 14, depending on how your Card class constructs Jokers
    if (this.isJoker(card)) {
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

  private calcScore(meld: Card[]): number {
    return meld.reduce((sum, c) => sum + this.getCardPoints(c), 0);
  }

  private canMakeMeld(meldCards: Card[], availableCards: Card[]): boolean {
    const tempHand = [...availableCards];
    for (const card of meldCards) {
      const index = tempHand.findIndex(c => c.id === card.id);
      if (index === -1) return false;
      tempHand.splice(index, 1);
    }
    return true;
  }

  private removeCards(source: Card[], toRemove: Card[]): Card[] {
    const res = [...source];
    for (const card of toRemove) {
      const idx = res.findIndex(c => c.id === card.id);
      if (idx !== -1) res.splice(idx, 1);
    }
    return res;
  }

  private countGapsInValues(sortedValues: number[]): number {
    let gaps = 0;
    for (let i = 0; i < sortedValues.length - 1; i++) {
      const diff = sortedValues[i + 1] - sortedValues[i];
      gaps += (diff - 1);
    }
    return gaps;
  }

  private filterUniqueSuits(cards: Card[]): Card[] {
    const seen = new Set<string>();
    return cards.filter(c => {
      if (seen.has(c.suit)) return false;
      seen.add(c.suit);
      return true;
    });
  }

  private getCombinations<T>(arr: T[], size: number): T[][] {
    if (size > arr.length) return [];
    if (size === 1) return arr.map(i => [i]);
    const result: T[][] = [];
    for (let i = 0; i < arr.length - size + 1; i++) {
      const head = arr[i];
      const tailCombinations = this.getCombinations(arr.slice(i + 1), size - 1);
      tailCombinations.forEach(tail => result.push([head, ...tail]));
    }
    return result;
  }

  // Add this helper method to the AIPlayer class:

private orderCardsInMeld(meld: Card[]): Card[] {
  // Check if it's a run or set
  if (!this.isValidRun(meld)) {
    // For sets, order doesn't matter much, just sort by suit
    return [...meld].sort((a, b) => {
      if (this.isJoker(a)) return 1;
      if (this.isJoker(b)) return -1;
      return a.suit.localeCompare(b.suit);
    });
  }

  // For runs, we need to position jokers correctly
  const jokers = meld.filter(c => this.isJoker(c));
  const regulars = meld.filter(c => !this.isJoker(c));
  
  if (regulars.length === 0) return meld;

  // Sort regular cards by value
  regulars.sort((a, b) => a.value - b.value);
  
  // Build the complete sequence
  const minValue = regulars[0].value;
  const maxValue = regulars[regulars.length - 1].value;
  
  const orderedMeld: Card[] = [];
  let jokerIndex = 0;
  
  for (let value = minValue; value <= maxValue; value++) {
    const regularCard = regulars.find(c => c.value === value);
    
    if (regularCard) {
      orderedMeld.push(regularCard);
    } else if (jokerIndex < jokers.length) {
      // This position needs a joker
      orderedMeld.push(jokers[jokerIndex]);
      jokerIndex++;
    }
  }
  
  // Add any remaining jokers at the end (shouldn't happen in valid melds)
  while (jokerIndex < jokers.length) {
    orderedMeld.push(jokers[jokerIndex]);
    jokerIndex++;
  }
  
  return orderedMeld;
}
}