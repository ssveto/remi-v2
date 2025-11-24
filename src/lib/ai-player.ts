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
}

interface HandSolution {
  melds: Card[][];
  remainingCards: Card[];
  totalScore: number;
}

export class AIPlayer {
  private config: AIConfig;

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
    const simulatedHand = [...hand, topDiscard];

    const currentSolution = this.solveHand(hand);
    const newSolution = this.solveHand(simulatedHand);

    // If we gain points, take it
    if (newSolution.totalScore > currentSolution.totalScore) return true;

    // Synergy Check
    const synergy = this.evaluateCardSynergy(topDiscard, hand);
    if (this.config.difficulty !== AIDifficulty.EASY && synergy > 25) {
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
    
    // 1. Solve Hand
    const solution = this.solveHand(hand);
    
    let meldsToLay: Card[][] = [];

    // 2. Strict Filter (The Safety Net)
    // We double-check strictly against the rules before proposing
    const validMelds = solution.melds.filter(meld => 
      this.isValidSet(meld) || this.isValidRun(meld)
    );

    // 3. Decide to Lay Down
    if (validMelds.length > 0) {
      if (hasOpened) {
        meldsToLay = validMelds;
      } else {
        // Calculate score only of VALID melds
        const score = validMelds.reduce((sum, m) => sum + this.calcScore(m), 0);
        if (score >= 51) {
          meldsToLay = validMelds;
        }
      }
    }

    // 4. Determine Discard
    // Identify which cards are NOT used in the melds we are about to lay
    const usedCardIds = new Set(meldsToLay.flat().map(c => c.id));
    const cardsAvailableToDiscard = hand.filter(c => !usedCardIds.has(c.id));

    let cardToDiscard: Card;

    if (cardsAvailableToDiscard.length === 0) {
      // Edge case: All cards used in melds. Must break one to discard.
      // We remove the last card from the last meld if possible, or just pick random.
      // (This prevents the 'all melds valid but no discard' crash)
      cardToDiscard = hand[0]; 
    } else {
      cardToDiscard = this.selectBestDiscard(cardsAvailableToDiscard);
    }

    return { meldsToLay, cardToDiscard };
  }

  // =========================================================================
  // SOLVER LOGIC
  // =========================================================================

  private solveHand(hand: Card[]): HandSolution {
    const candidates = this.findAllCandidates(hand);
    // Sort candidates by score (highest first) to prioritize high-value melds
    candidates.sort((a, b) => b.score - a.score);

    return this.findBestCombination(candidates, hand, [], 0);
  }

  private findBestCombination(
    candidates: MeldCandidate[],
    availableCards: Card[],
    chosenMelds: Card[][],
    currentScore: number
  ): HandSolution {
    let bestSolution: HandSolution = {
      melds: chosenMelds,
      remainingCards: availableCards,
      totalScore: currentScore
    };

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];

      // CRITICAL: Check if specific card instances are available
      if (this.canMakeMeld(candidate.cards, availableCards)) {
        
        const remainingAfterMeld = this.removeCards(availableCards, candidate.cards);
        const newMelds = [...chosenMelds, candidate.cards];
        const newScore = currentScore + candidate.score;

        // Recurse
        const subResult = this.findBestCombination(
          candidates.slice(i + 1), 
          remainingAfterMeld,
          newMelds,
          newScore
        );

        if (subResult.totalScore > bestSolution.totalScore) {
          bestSolution = subResult;
        }
      }
    }

    return bestSolution;
  }

  // =========================================================================
  // CANDIDATE GENERATOR
  // =========================================================================

  private findAllCandidates(hand: Card[]): MeldCandidate[] {
    const candidates: MeldCandidate[] = [];
    const jokers = hand.filter(c => this.isJoker(c));
    const regulars = hand.filter(c => !this.isJoker(c));

    // --- 1. SETS ---
    const byValue = new Map<number, Card[]>();
    regulars.forEach(c => {
      const val = c.value;
      if (!byValue.has(val)) byValue.set(val, []);
      byValue.get(val)!.push(c);
    });

    byValue.forEach((cards) => {
      // Get unique suits to avoid duplicates in a set
      const distinct = this.filterUniqueSuits(cards);
      
      // Combinations of 3
      if (distinct.length >= 3) {
        this.getCombinations(distinct, 3).forEach(combo => {
          if (this.isValidSet(combo)) {
            candidates.push({ cards: combo, score: this.calcScore(combo), type: 'SET' });
          }
        });
      }
      
      // Combinations of 4
      if (distinct.length >= 4) {
         this.getCombinations(distinct, 4).forEach(combo => {
          if (this.isValidSet(combo)) {
            candidates.push({ cards: combo, score: this.calcScore(combo), type: 'SET' });
          }
        });
      }

      // Sets with 1 Joker
      if (jokers.length > 0) {
        // Pair + Joker
        if (distinct.length >= 2) {
          this.getCombinations(distinct, 2).forEach(pair => {
            const withJoker = [...pair, jokers[0]];
            if (this.isValidSet(withJoker)) {
              candidates.push({ cards: withJoker, score: this.calcScore(withJoker), type: 'SET' });
            }
          });
        }
        // Triplet + Joker
        if (distinct.length >= 3) {
          this.getCombinations(distinct, 3).forEach(triplet => {
            const withJoker = [...triplet, jokers[0]];
            if (this.isValidSet(withJoker)) {
              candidates.push({ cards: withJoker, score: this.calcScore(withJoker), type: 'SET' });
            }
          });
        }
      }
    });

    // --- 2. RUNS ---
    const bySuit = new Map<string, Card[]>();
    regulars.forEach(c => {
      if (!bySuit.has(c.suit)) bySuit.set(c.suit, []);
      bySuit.get(c.suit)!.push(c);
    });

    bySuit.forEach((cards) => {
      // Sort
      cards.sort((a, b) => a.value - b.value);
      // Unique values for logic (handles 2-deck duplicates)
      const uniqueValues = Array.from(new Set(cards.map(c => c.value))).sort((a,b)=>a-b);

      for (let i = 0; i < uniqueValues.length; i++) {
        for (let j = i + 1; j < uniqueValues.length; j++) {
           const valSubset = uniqueValues.slice(i, j + 1);
           
           // Construct card array
           // Important: filter from 'cards' (which are all same suit)
           const cardSubset = valSubset.map(v => cards.find(c => c.value === v)!);

           // Pure Run
           if (this.isValidRun(cardSubset)) {
             candidates.push({ cards: cardSubset, score: this.calcScore(cardSubset), type: 'RUN' });
           }

           // Run with Jokers
           if (jokers.length > 0) {
             const gaps = this.countGapsInValues(valSubset);
             if (gaps > 0 && gaps <= jokers.length) {
               const withJokers = [...cardSubset];
               for(let k=0; k<gaps; k++) withJokers.push(jokers[k]);
               
               // Re-validate to be sure
               if (this.isValidRun(withJokers)) {
                 candidates.push({ cards: withJokers, score: this.calcScore(withJokers), type: 'RUN' });
               }
             }
           }
        }
      }
    });

    return candidates;
  }

  // =========================================================================
  // VALIDATION RULES (Mirrors Remi.ts)
  // =========================================================================

  private isValidSet(cards: Card[]): boolean {
    if (cards.length < 3 || cards.length > 4) return false;

    const jokers = cards.filter(c => this.isJoker(c));
    const regularCards = cards.filter(c => !this.isJoker(c));

    if (jokers.length > 1) return false;
    if (regularCards.length === 0) return false;

    const targetValue = regularCards[0].value;
    if (!regularCards.every(c => c.value === targetValue)) return false;

    // Distinct suits
    const suits = new Set(regularCards.map(c => c.suit));
    return suits.size === regularCards.length;
  }

  private isValidRun(cards: Card[]): boolean {
    if (cards.length < 3) return false;

    const jokers = cards.filter(c => this.isJoker(c));
    const regularCards = cards.filter(c => !this.isJoker(c));

    if (regularCards.length === 0) return false;

    // Same suit
    const targetSuit = regularCards[0].suit;
    if (!regularCards.every(c => c.suit === targetSuit)) return false;

    // Sequence check
    const values = regularCards.map(c => c.value).sort((a, b) => a - b);
    return this.canFormSequence(values, jokers.length);
  }

  private canFormSequence(sortedValues: number[], jokerCount: number): boolean {
    if (sortedValues.length === 0) return false;
    if (sortedValues.length === 1) return (1 + jokerCount) >= 3;

    let jokersNeeded = 0;
    for (let i = 1; i < sortedValues.length; i++) {
      const gap = sortedValues[i] - sortedValues[i - 1] - 1;
      if (gap < 0) return false; // Duplicate or invalid sort
      jokersNeeded += gap;
    }

    return jokersNeeded <= jokerCount;
  }

  // =========================================================================
  // HELPERS
  // =========================================================================

  private selectBestDiscard(cards: Card[]): Card {
    const scores = cards.map(card => {
      // Never discard a joker
      if (this.isJoker(card)) return { card, score: 9999 };

      let score = 0;
      // High value cards are good to discard (to minimize deadwood points)
      score -= this.getCardPoints(card); 
      // Synergy bonus (keep cards that are near others)
      score += this.evaluateCardSynergy(card, cards) * 10;

      return { card, score };
    });

    // Sort ascending (lowest score = best discard)
    scores.sort((a, b) => a.score - b.score);
    return scores[0].card;
  }

  private evaluateCardSynergy(card: Card, hand: Card[]): number {
    let synergy = 0;
    const regulars = hand.filter(c => !this.isJoker(c) && c.id !== card.id);

    // Pair bonus
    const pairs = regulars.filter(c => c.value === card.value).length;
    synergy += pairs * 5;

    // Neighbor bonus (same suit, value within 2)
    const neighbors = regulars.filter(c => 
      c.suit === card.suit && Math.abs(c.value - card.value) <= 2
    ).length;
    synergy += neighbors * 4;

    return synergy;
  }

  private isJoker(card: Card): boolean {
    return card.suit === "JOKER_RED" || card.suit === "JOKER_BLACK" || card.value === 14;
  }

  private getCardPoints(card: Card): number {
    if (card.value === 1) return 10;
    if (card.value >= 10 && card.value < 14) return 10;
    if (card.value === 14) return 0;
    return card.value;
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
}