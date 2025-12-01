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
  priority: number; // Strategic value
}

interface HandSolution {
  melds: Card[][];
  remainingCards: Card[];
  totalScore: number;
  deadwoodValue: number;
  canGoOut: boolean; // Can win this turn
}

interface OpponentModel {
  knownDiscards: Card[];
  estimatedDeadwood: number;
  hasOpened: boolean;
  recentDraws: ('deck' | 'discard')[];
  likelyNeeds: Set<number>; // Values they might need
}

/**
 * IMPROVEMENTS FOR HARD AI:
 * 1. Uses Remi's actual validation logic for melds
 * 2. Advanced run detection with proper joker positioning
 * 3. Strategic opening timing (holds back if close to winning)
 * 4. Aggressive discard selection (denies opponent useful cards)
 * 5. Multi-turn planning and card counting
 * 6. Proper Ace handling (low/high ace in runs)
 */
export class AIPlayer {
  private config: AIConfig;
  private opponentModels: Map<number, OpponentModel> = new Map();
  private seenCards: Set<string> = new Set();
  private deckProbabilities: Map<number, number> = new Map();

  constructor(config: AIConfig) {
    this.config = config;
    this.initializeProbabilities();
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

    // Simulate adding the card
    const simulatedHand = [...hand, topDiscard];
    const solution = this.solveHandWithValidation(simulatedHand, logic, playerIndex);

    // Determine which melds would be laid down this turn
    const meldsToLay = this.determineMeldsToLay(
      solution,
      hasOpened,
      simulatedHand,
      logic,
      playerIndex
    );

    if (meldsToLay.length === 0) {
      return false;  // Not laying melds - can't take
    }

    // ⭐ KEY CHECK: Is discard card IN the melds being laid down?
    const discardCardIsInMelds = meldsToLay.some(meld =>
      meld.some(card => card.id === topDiscard.id)
    );

    if (!discardCardIsInMelds) {
      return false;  // Card won't be used - can't take
    }

    // ⭐ If not opened, check 51-point requirement
    if (!hasOpened) {
      const totalScore = meldsToLay.reduce((sum, meld) =>
        sum + this.calcScore(meld), 0
      );
      if (totalScore < 51) {
        return false;  // Doesn't meet opening requirement
      }
    }

    // Legal to take - now check if it's smart
    this.trackCard(topDiscard);

    const currentSolution = this.solveHandWithValidation(hand, logic, playerIndex);
    const scoreImprovement = solution.totalScore - currentSolution.totalScore;

    if (this.config.difficulty === AIDifficulty.EASY) {
      return scoreImprovement >= 5;
    }

    if (this.config.difficulty === AIDifficulty.HARD) {
      // Can go out?
      if (solution.canGoOut) return true;

      // Deny opponent
      const opponentWants = this.estimateOpponentInterestAdvanced(topDiscard, hand);
      if (opponentWants > 15) return true;

      // Good improvement
      return scoreImprovement >= 3;
    }

    return scoreImprovement >= 5;
  }

  private determineMeldsToLay(
    solution: HandSolution,
    hasOpened: boolean,
    hand: Card[],
    logic: Remi,
    playerIndex: number
  ): Card[][] {
    // Replicate logic from planMeldAndDiscard
    let meldsToLay: Card[][] = [];

    if (hasOpened) {
      if (solution.canGoOut) {
        meldsToLay = solution.melds;
      } else if (solution.remainingCards.length <= 3) {
        meldsToLay = solution.melds;
      } else {
        meldsToLay = solution.melds.filter(m => this.calcScore(m) >= 15);
      }
    } else {
      if (solution.totalScore >= 51) {
        meldsToLay = solution.melds;
      }
    }

    return meldsToLay;
  }

  public planMeldAndDiscard(logic: Remi, playerIndex: number): {
    meldsToLay: Card[][];
    cardToDiscard: Card;
    cardsToAddToMelds?: Array<{ card: Card; meldOwner: number; meldIndex: number }>;
  } {
    const hand = logic.getPlayerHand(playerIndex);
    const hasOpened = logic.hasPlayerOpened(playerIndex);
    const state = logic.getState();

    // 1. Solve hand using actual game validation
    const solution = this.solveHandWithValidation(hand, logic, playerIndex);

    let meldsToLay: Card[][] = [];
    const cardsToAddToMelds: Array<{ card: Card; meldOwner: number; meldIndex: number }> = [];

    // 2. HARD AI: Strategic meld laying
    if (this.config.difficulty === AIDifficulty.HARD) {
      const totalScore = solution.totalScore;

      if (hasOpened) {
        // Already opened: Be strategic about what to lay
        if (solution.canGoOut && solution.remainingCards.length === 1) {
          // Go out immediately!
          meldsToLay = solution.melds;
        } else if (solution.remainingCards.length <= 3 && solution.deadwoodValue <= 15) {
          // Close to winning: lay everything to reduce deadwood
          meldsToLay = solution.melds;
        } else if (totalScore >= 30) {
          // Lay down high-value melds to secure points
          const highValueMelds = solution.melds.filter(m => this.calcScore(m) >= 15);
          meldsToLay = highValueMelds.length > 0 ? highValueMelds : solution.melds;
        } else {
          // Hold some melds for future flexibility
          meldsToLay = solution.melds.slice(0, Math.max(1, Math.floor(solution.melds.length / 2)));
        }
      } else {
        // Not opened: Check if we meet 51-point requirement
        if (totalScore >= 51) {
          const remainingAfterMelds = hand.filter(c =>
            !solution.melds.flat().some(mc => mc.id === c.id)
          );
          const remainingDeadwood = this.calculateDeadwood(remainingAfterMelds);

          // Strategic opening decision
          if (remainingDeadwood <= 10 && remainingAfterMelds.length <= 2) {
            // Very close to going out - consider holding back to go out next turn
            meldsToLay = [];
          } else if (totalScore >= 70) {
            // High score - open aggressively
            meldsToLay = solution.melds;
          } else if (remainingAfterMelds.length <= 4) {
            // Good position - open
            meldsToLay = solution.melds;
          } else {
            // Marginal - be cautious
            meldsToLay = [];
          }
        }
      }
    } else {
      // Medium/Easy AI: Simpler logic
      if (hasOpened) {
        meldsToLay = solution.melds;
      } else if (solution.totalScore >= 51) {
        meldsToLay = solution.melds;
      }
    }

    // 3. Order cards properly in each meld using game's sorting rules
    meldsToLay = meldsToLay.map(meld => this.orderCardsInMeldAdvanced(meld));

    // 3.1. CRITICAL: Ensure we have at least 1 card left to discard
    // Calculate how many cards will remain after laying melds
    const cardsInMelds = meldsToLay.flat();
    const cardsRemainingAfterMelds = hand.filter(c =>
      !cardsInMelds.some(mc => mc.id === c.id)
    );

    // If no cards will remain, we MUST hold back at least one meld
    if (cardsRemainingAfterMelds.length === 0 && meldsToLay.length > 0) {
      // Remove the smallest/least valuable meld to ensure we have cards to discard
      const meldScores = meldsToLay.map((meld, index) => ({
        meld,
        index,
        score: this.calcScore(meld),
        size: meld.length
      }));

      // Sort by score (ascending) - remove the least valuable meld
      meldScores.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        return a.size - b.size; // If scores equal, remove smaller meld
      });

      // Remove the least valuable meld
      meldsToLay = meldsToLay.filter((_, idx) => idx !== meldScores[0].index);

      console.log(`AI held back a meld to ensure discard is possible`);
    }

    // 3.5. STRATEGIC: If opened, look for opportunities to add cards to existing melds
    if (hasOpened && this.config.difficulty === AIDifficulty.HARD) {
      const usedInMelds = new Set(meldsToLay.flat().map(c => c.id));
      const availableForAdding = hand.filter(c => !usedInMelds.has(c.id));

      // CRITICAL: We need to leave at least 1 card for discard
      // So we can add at most (availableForAdding.length - 1) cards
      const maxCardsToAdd = Math.max(0, availableForAdding.length - 1);

      if (maxCardsToAdd > 0) {
        // Find all existing melds on the table (all players)
        const allTableMelds = this.getAllTableMelds(logic, state);

        // Evaluate all possible additions and pick the best ones
        const possibleAdditions: Array<{
          card: Card;
          meldOwner: number;
          meldIndex: number;
          score: number;
        }> = [];

        for (const card of availableForAdding) {
          const bestTarget = this.findBestMeldToAddCard(card, allTableMelds, logic, playerIndex);

          if (bestTarget) {
            possibleAdditions.push({
              card,
              meldOwner: bestTarget.owner,
              meldIndex: bestTarget.index,
              score: bestTarget.score
            });
          }
        }

        // Sort by score (descending) - add highest value cards first
        possibleAdditions.sort((a, b) => b.score - a.score);

        // Take the top N additions (leaving 1 card for discard)
        const additionsToMake = possibleAdditions.slice(0, maxCardsToAdd);

        for (const addition of additionsToMake) {
          cardsToAddToMelds.push({
            card: addition.card,
            meldOwner: addition.meldOwner,
            meldIndex: addition.meldIndex
          });

          // Mark as used
          usedInMelds.add(addition.card.id);
        }
      }
    }

    // 4. Determine discard using advanced selection
    const usedCardIds = new Set(meldsToLay.flat().map(c => c.id));
    const cardsAvailableToDiscard = hand.filter(c => !usedCardIds.has(c.id));

    let cardToDiscard: Card;

    if (cardsAvailableToDiscard.length === 0) {
      // Edge case: must break a meld to discard
      cardToDiscard = this.selectCardFromMelds(meldsToLay, hand);
    } else {
      cardToDiscard = this.selectBestDiscardAdvanced(
        cardsAvailableToDiscard,
        state,
        playerIndex,
        logic,
        hand
      );
    }

    // Track discard
    this.trackCard(cardToDiscard);

    return { meldsToLay, cardToDiscard, cardsToAddToMelds };
  }

  // =========================================================================
  // MELD ADDITION LOGIC (Adding to other player's melds)
  // =========================================================================

  private getAllTableMelds(logic: Remi, state: any): Array<{ cards: Card[]; owner: number; index: number }> {
    const allMelds: Array<{ cards: Card[]; owner: number; index: number }> = [];

    // Get all player melds from state
    for (let owner = 0; owner < state.numPlayers; owner++) {
      const playerMelds = logic.getPlayerMelds(owner);
      playerMelds.forEach((meld, index) => {
        allMelds.push({ cards: meld, owner, index });
      });
    }

    return allMelds;
  }

  private findBestMeldToAddCard(
    card: Card,
    allMelds: Array<{ cards: Card[]; owner: number; index: number }>,
    logic: Remi,
    playerIndex: number
  ): { owner: number; index: number; score: number } | null {
    let bestTarget: { owner: number; index: number; score: number } | null = null;

    for (const meld of allMelds) {
      // Check if adding this card would create a valid meld
      const testMeld = [...meld.cards, card];

      if (this.isValidSet(testMeld) || this.isValidRun(testMeld)) {
        // Calculate strategic score for this addition
        let score = 0;

        // 1. Base value: reduces our deadwood
        score += this.getCardPoints(card) * 10;

        // 2. Bonus: Replaces a joker (we get the joker back!)
        const hasJoker = meld.cards.some(c => this.isJoker(c));
        if (hasJoker && this.wouldReplaceJoker(card, meld.cards)) {
          score += 100; // HUGE bonus - we get a joker!
        }

        // 3. Bonus: Adding to opponent's meld (denies them flexibility)
        if (meld.owner !== playerIndex) {
          score += 20;
        }

        // 4. Bonus: Extends meld significantly
        if (testMeld.length >= 6) {
          score += 15;
        }

        if (!bestTarget || score > bestTarget.score) {
          bestTarget = { owner: meld.owner, index: meld.index, score };
        }
      }
    }

    return bestTarget;
  }

  private wouldReplaceJoker(card: Card, meld: Card[]): boolean {
    if (this.isJoker(card)) return false;

    const jokerIndex = meld.findIndex(c => this.isJoker(c));
    if (jokerIndex === -1) return false;

    // Try replacing the joker
    const meldWithReplacement = [...meld];
    meldWithReplacement[jokerIndex] = card;

    // Check if still valid
    if (this.isValidSet(meldWithReplacement) || this.isValidRun(meldWithReplacement)) {
      // Additional check: does this card specifically replace the joker's role?
      const regularCards = meld.filter(c => !this.isJoker(c));

      if (regularCards.length === 0) return false;

      // For sets: card must match value and have unique suit
      if (regularCards.every(c => c.value === regularCards[0].value)) {
        const suits = new Set(regularCards.map(c => c.suit));
        return card.value === regularCards[0].value && !suits.has(card.suit);
      }

      // For runs: card must fit in the sequence
      return true;
    }

    return false;
  }

  // =========================================================================
  // ADVANCED SOLVER (Uses Real Game Validation)
  // =========================================================================

  private solveHandWithValidation(hand: Card[], logic: Remi, playerIndex: number): HandSolution {
    // Use game's actual validation to find valid melds
    const candidates = this.findAllValidCandidates(hand, logic, playerIndex);

    // Sort by strategic priority
    candidates.sort((a, b) => {
      // Prioritize by efficiency, then score, then strategic value
      if (Math.abs(b.efficiency - a.efficiency) > 0.5) {
        return b.efficiency - a.efficiency;
      }
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return b.score - a.score;
    });

    const solution = this.findBestCombinationAdvanced(candidates, hand, [], 0, 0);

    // Calculate deadwood and check if can go out
    const deadwoodValue = this.calculateDeadwood(solution.remainingCards);
    const canGoOut = solution.remainingCards.length === 1;

    return {
      ...solution,
      deadwoodValue,
      canGoOut
    };
  }

  private findAllValidCandidates(hand: Card[], logic: Remi, playerIndex: number): MeldCandidate[] {
    const candidates: MeldCandidate[] = [];
    const handSize = hand.length;

    // Try all possible meld sizes (3 to handSize)
    for (let size = 3; size <= Math.min(handSize, 13); size++) {
      const combinations = this.getCombinations(hand, size);

      for (const combo of combinations) {
        // Use game's validation
        const validation = logic.validateMelds(playerIndex, combo);

        if (validation.validMelds.length > 0) {
          // Each valid meld group from the validation
          for (let i = 0; i < validation.validMelds.length; i++) {
            const meld = validation.validMelds[i];
            const score = validation.meldScores[i];
            const efficiency = score / meld.length;

            // Determine type
            const type = this.isValidSet(meld) ? 'SET' : 'RUN';

            // Calculate strategic priority
            const priority = this.calculateMeldPriority(meld, hand, type);

            candidates.push({
              cards: meld,
              score,
              type,
              efficiency,
              priority
            });
          }
        }
      }
    }

    // Remove duplicates (same cards, different order)
    return this.deduplicateCandidates(candidates);
  }

  private calculateMeldPriority(meld: Card[], hand: Card[], type: string): number {
    let priority = 0;

    // Prefer longer melds
    priority += meld.length * 2;

    // Prefer melds with jokers (more flexible)
    const jokerCount = meld.filter(c => this.isJoker(c)).length;
    priority += jokerCount * 5;

    // Prefer runs over sets (generally more valuable)
    if (type === 'RUN') priority += 3;

    // Prefer melds that reduce high-value deadwood
    const highValueCards = meld.filter(c => this.getCardPoints(c) >= 10);
    priority += highValueCards.length * 2;

    return priority;
  }

  private deduplicateCandidates(candidates: MeldCandidate[]): MeldCandidate[] {
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

  private findBestCombinationAdvanced(
    candidates: MeldCandidate[],
    availableCards: Card[],
    chosenMelds: Card[][],
    currentScore: number,
    depth: number
  ): HandSolution {
    // Prevent infinite recursion
    if (depth > 25) {
      return {
        melds: chosenMelds,
        remainingCards: availableCards,
        totalScore: currentScore,
        deadwoodValue: this.calculateDeadwood(availableCards),
        canGoOut: availableCards.length === 1
      };
    }

    let bestSolution: HandSolution = {
      melds: chosenMelds,
      remainingCards: availableCards,
      totalScore: currentScore,
      deadwoodValue: this.calculateDeadwood(availableCards),
      canGoOut: availableCards.length === 1
    };

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];

      if (this.canMakeMeld(candidate.cards, availableCards)) {
        const remainingAfterMeld = this.removeCards(availableCards, candidate.cards);
        const newMelds = [...chosenMelds, candidate.cards];
        const newScore = currentScore + candidate.score;

        const subResult = this.findBestCombinationAdvanced(
          candidates.slice(i + 1),
          remainingAfterMeld,
          newMelds,
          newScore,
          depth + 1
        );

        // Multi-criteria optimization
        const isBetter = this.isBetterSolution(subResult, bestSolution);

        if (isBetter) {
          bestSolution = subResult;
        }
      }
    }

    return bestSolution;
  }

  private isBetterSolution(candidate: HandSolution, current: HandSolution): boolean {
    // 1. Prioritize going out
    if (candidate.canGoOut && !current.canGoOut) return true;
    if (!candidate.canGoOut && current.canGoOut) return false;

    // 2. Higher score is better
    if (candidate.totalScore > current.totalScore + 5) return true;
    if (current.totalScore > candidate.totalScore + 5) return false;

    // 3. Lower deadwood is better (if scores are similar)
    if (Math.abs(candidate.totalScore - current.totalScore) <= 5) {
      return candidate.deadwoodValue < current.deadwoodValue;
    }

    return candidate.totalScore > current.totalScore;
  }

  // =========================================================================
  // ADVANCED CARD ORDERING (Mirrors Game Logic)
  // =========================================================================

  private orderCardsInMeldAdvanced(meld: Card[]): Card[] {
    if (!this.isValidRun(meld)) {
      // For sets, order by suit (jokers last)
      return [...meld].sort((a, b) => {
        if (this.isJoker(a)) return 1;
        if (this.isJoker(b)) return -1;
        return a.suit.localeCompare(b.suit);
      });
    }

    // For runs: Mirror the game's sorting logic
    const jokers = meld.filter(c => this.isJoker(c));
    const regulars = meld.filter(c => !this.isJoker(c));

    if (regulars.length === 0) return meld;

    // Check if we need high ace
    const hasHighCards = regulars.some(r => r.value >= 11);

    // Sort regular cards with proper Ace handling
    regulars.sort((a, b) => {
      const aVal = a.value === 1 && hasHighCards ? 14 : a.value;
      const bVal = b.value === 1 && hasHighCards ? 14 : b.value;
      return aVal - bVal;
    });

    // Build sequence with jokers filling gaps
    const result: Card[] = [];
    let jokerIdx = 0;

    for (let i = 0; i < regulars.length; i++) {
      const current = regulars[i];
      const next = regulars[i + 1];

      result.push(current);

      if (next) {
        // Calculate gap
        const currentVal = current.value === 1 && hasHighCards ? 14 : current.value;
        const nextVal = next.value === 1 && hasHighCards ? 14 : next.value;
        const gap = nextVal - currentVal - 1;

        // Insert jokers to fill gap
        const jokersToInsert = Math.min(gap, jokers.length - jokerIdx);
        for (let j = 0; j < jokersToInsert; j++) {
          result.push(jokers[jokerIdx++]);
        }
      }
    }

    // Add remaining jokers
    while (jokerIdx < jokers.length) {
      result.push(jokers[jokerIdx++]);
    }

    return result;
  }

  // =========================================================================
  // ADVANCED DISCARD SELECTION
  // =========================================================================

  public selectBestDiscardAdvanced(
    cards: Card[],
    state: any,
    playerIndex: number,
    logic: Remi,
    fullHand: Card[]
  ): Card {
    const scores = cards.map(card => {
      // NEVER discard jokers
      if (this.isJoker(card)) return { card, score: 9999 };

      let score = 0;

      // 1. High deadwood penalty (aggressive)
      const cardValue = this.getCardPoints(card);
      score -= cardValue * 3;

      // 2. Synergy bonus (keep useful cards)
      const synergy = this.evaluateCardSynergyAdvanced(card, cards);
      score += synergy * 2;

      // 3. Future potential
      const potential = this.evaluateFuturePotentialAdvanced(card, cards, fullHand);
      score += potential * 3;

      // 4. HARD AI: Opponent denial
      if (this.config.difficulty === AIDifficulty.HARD) {
        const opponentWants = this.estimateOpponentInterestAdvanced(card, fullHand);
        score -= opponentWants * 4; // Strongly avoid giving useful cards

        // Don't discard cards that could complete opponent's melds
        if (this.isMiddleRankCard(card)) {
          score -= 5; // Mid-range cards are most useful
        }

        // Prefer discarding duplicates we've seen
        if (this.hasSeenSimilarCard(card)) {
          score += 10; // Safer to discard
        }
      }

      // 5. Isolation penalty (cards that don't connect to anything)
      const isolation = this.calculateIsolationScore(card, fullHand);
      score -= isolation * 2;

      return { card, score };
    });

    // Sort by score (lowest = best to discard)
    scores.sort((a, b) => a.score - b.score);

    // Hard AI: Pick from worst few with slight randomness
    const numWorst = Math.min(2, scores.length);
    const worstChoices = scores.slice(0, numWorst);

    if (this.config.randomness > 0 && worstChoices.length > 1) {
      const randomIndex = Math.random() < 0.3 ? 1 : 0;
      return worstChoices[randomIndex].card;
    }

    return worstChoices[0].card;
  }

  private evaluateCardSynergyAdvanced(card: Card, hand: Card[]): number {
    if (this.isJoker(card)) return 100; // Keep jokers

    let synergy = 0;
    const regulars = hand.filter(c => !this.isJoker(c) && c.id !== card.id);

    // Set potential
    const sameValue = regulars.filter(c => c.value === card.value);
    synergy += sameValue.length * 12;
    if (sameValue.length >= 2) synergy += 20; // Almost a set

    // Run potential (same suit)
    const sameSuit = regulars.filter(c => c.suit === card.suit);
    for (const other of sameSuit) {
      const distance = Math.abs(other.value - card.value);
      if (distance === 1) synergy += 15; // Adjacent
      else if (distance === 2) synergy += 8; // One gap
      else if (distance === 3) synergy += 3; // Two gaps
    }

    // Joker synergy (jokers can complete with this card)
    const jokerCount = hand.filter(c => this.isJoker(c)).length;
    if (jokerCount > 0 && sameValue.length > 0) synergy += jokerCount * 10;

    return synergy;
  }

  private evaluateFuturePotentialAdvanced(card: Card, availableCards: Card[], fullHand: Card[]): number {
    let potential = 0;

    // Strong set potential
    const sameValue = fullHand.filter(c => c.value === card.value && c.id !== card.id);
    potential += sameValue.length * 5;
    if (sameValue.length === 2) potential += 15; // One away from set

    // Run potential with deck probability
    const sameSuit = fullHand.filter(c => c.suit === card.suit && c.id !== card.id);
    for (const other of sameSuit) {
      const distance = Math.abs(other.value - card.value);
      if (distance <= 2) {
        // Check if we could draw the missing card
        const probability = this.estimateDeckProbability(card.suit, card.value);
        potential += (3 - distance) * probability;
      }
    }

    return potential;
  }

  private estimateOpponentInterestAdvanced(card: Card, hand: Card[]): number {
    let interest = 0;

    // Mid-range cards (5-9) are most flexible for runs
    if (card.value >= 5 && card.value <= 9) interest += 8;

    // Face cards and aces useful for sets and high-value runs
    if (card.value === 1 || card.value >= 11) interest += 5;

    // Cards of common suits
    if (card.suit === "HEART" || card.suit === "SPADE") interest += 2;

    // Check if this card fits common meld patterns
    const couldFormSet = hand.filter(c => c.value === card.value).length >= 1;
    if (couldFormSet) interest += 6;

    return interest;
  }

  private calculateIsolationScore(card: Card, hand: Card[]): number {
    if (this.isJoker(card)) return 0;

    let connections = 0;

    // Check for cards of same value
    connections += hand.filter(c => c.value === card.value && c.id !== card.id).length * 5;

    // Check for cards of same suit within range
    const sameSuit = hand.filter(c => c.suit === card.suit && c.id !== card.id);
    for (const other of sameSuit) {
      const distance = Math.abs(other.value - card.value);
      if (distance <= 3) connections += (4 - distance) * 3;
    }

    // Isolated cards have low connections
    return Math.max(0, 20 - connections);
  }

  private isMiddleRankCard(card: Card): boolean {
    return card.value >= 4 && card.value <= 10;
  }

  private hasSeenSimilarCard(card: Card): boolean {
    // Check if we've seen cards of same value or nearby values in same suit
    const key1 = `${card.value}-${card.suit}`;
    const key2 = `${card.value - 1}-${card.suit}`;
    const key3 = `${card.value + 1}-${card.suit}`;

    return this.seenCards.has(key1) || this.seenCards.has(key2) || this.seenCards.has(key3);
  }

  // =========================================================================
  // STRATEGIC HELPERS
  // =========================================================================

  private shouldGoOutNow(solution: HandSolution, hasOpened: boolean): boolean {
    // Always go out if possible and opened
    if (hasOpened && solution.canGoOut) return true;

    // Go out if not opened but score is way over 51
    if (!hasOpened && solution.totalScore >= 60 && solution.canGoOut) return true;

    return false;
  }

  private wouldCompleteImmediate(card: Card, hand: Card[], hasOpened: boolean, logic: Remi): boolean {
    const simulatedHand = [...hand, card];
    const playerIndex = 0; // Assume AI is player 0 for validation

    const validation = logic.validateMelds(playerIndex, simulatedHand);

    if (!hasOpened) {
      return validation.meetsOpenRequirement;
    }

    return validation.validMelds.length > 0;
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
  // CARD TRACKING & PROBABILITY
  // =========================================================================

  private initializeProbabilities(): void {
    // Initialize deck probabilities for each rank
    for (let value = 1; value <= 13; value++) {
      this.deckProbabilities.set(value, 8); // 8 of each rank in 2 decks
    }
    this.deckProbabilities.set(14, 4); // 4 jokers
  }

  private trackCard(card: Card): void {
    const key = `${card.value}-${card.suit}`;
    this.seenCards.add(key);

    // Update probabilities
    const current = this.deckProbabilities.get(card.value) || 0;
    this.deckProbabilities.set(card.value, Math.max(0, current - 1));
  }

  private estimateDeckProbability(suit: string, value: number): number {
    const remaining = this.deckProbabilities.get(value) || 0;
    // Return 0-10 score based on how many are left
    return Math.min(10, remaining * 1.5);
  }

  // =========================================================================
  // SIMPLE EVALUATION HELPERS (for Medium/Easy)
  // =========================================================================

  private evaluateCardSynergy(card: Card, hand: Card[]): number {
    let synergy = 0;
    const regulars = hand.filter(c => !this.isJoker(c) && c.id !== card.id);

    // Set potential
    const sameValue = regulars.filter(c => c.value === card.value);
    synergy += sameValue.length * 8;

    // Run potential
    const sameSuit = regulars.filter(c => c.suit === card.suit);
    for (const other of sameSuit) {
      const distance = Math.abs(other.value - card.value);
      if (distance === 1) synergy += 10;
      else if (distance === 2) synergy += 5;
      else if (distance === 3) synergy += 2;
    }

    return synergy;
  }

  private calculateDeadwood(cards: Card[]): number {
    return cards.reduce((sum, card) => sum + this.getCardPoints(card), 0);
  }

  // =========================================================================
  // MELD VALIDATION (Mirrors Game Logic)
  // =========================================================================

  private isValidSet(cards: Card[]): boolean {
    if (cards.length < 3) return false;

    const regulars = cards.filter(c => !this.isJoker(c));
    const jokers = cards.filter(c => this.isJoker(c));

    if (regulars.length === 0) return false;

    // All regular cards must have same value
    const targetValue = regulars[0].value;
    if (!regulars.every(c => c.value === targetValue)) return false;

    // All regular cards must have different suits
    const suits = new Set(regulars.map(c => c.suit));
    if (suits.size !== regulars.length) return false;

    // Can't have more than 4 cards in a set (4 suits max)
    if (regulars.length + jokers.length > 4) return false;

    return true;
  }

  private isValidRun(cards: Card[]): boolean {
    if (cards.length < 3) return false;

    const regularCards = cards.filter(c => !this.isJoker(c));

    if (regularCards.length === 0) return false;

    // All regular cards must be same suit
    const targetSuit = regularCards[0].suit;
    if (!regularCards.every(c => c.suit === targetSuit)) return false;

    // Check positional gaps with sorted cards
    const sortedCards = this.sortRunCardsForValidation(cards);
    return this.validatePositionalRun(sortedCards);
  }

  private sortRunCardsForValidation(cards: Card[]): Card[] {
    const indexed = cards.map((card, index) => ({
      card,
      originalIndex: index,
      isJoker: this.isJoker(card)
    }));

    const jokers = indexed.filter(item => item.isJoker);
    const regulars = indexed.filter(item => !item.isJoker);

    // Sort regular cards
    const hasHighCards = regulars.some(r => r.card.value >= 11);
    regulars.sort((a, b) => {
      const aVal = a.card.value === 1 && hasHighCards ? 14 : a.card.value;
      const bVal = b.card.value === 1 && hasHighCards ? 14 : b.card.value;
      return aVal - bVal;
    });

    // Interleave jokers
    const result: Card[] = [];
    let jokerIdx = 0;

    for (let i = 0; i < regulars.length; i++) {
      const current = regulars[i].card;
      const next = regulars[i + 1]?.card;

      result.push(current);

      if (next) {
        const currentVal = current.value === 1 && hasHighCards ? 14 : current.value;
        const nextVal = next.value === 1 && hasHighCards ? 14 : next.value;
        const gap = nextVal - currentVal - 1;

        const jokersToInsert = Math.min(gap, jokers.length - jokerIdx);
        for (let j = 0; j < jokersToInsert; j++) {
          result.push(jokers[jokerIdx++].card);
        }
      }
    }

    while (jokerIdx < jokers.length) {
      result.push(jokers[jokerIdx++].card);
    }

    return result;
  }

  private validatePositionalRun(cards: Card[]): boolean {
    const indexedRegulars = cards
      .map((card, index) => ({ card, index, isJoker: this.isJoker(card) }))
      .filter(item => !item.isJoker);

    if (indexedRegulars.length < 2) return true;

    let isAscending: boolean | null = null;

    for (let i = 0; i < indexedRegulars.length - 1; i++) {
      const current = indexedRegulars[i];
      const next = indexedRegulars[i + 1];

      const jokersBetween = next.index - current.index - 1;
      const requiredGap = jokersBetween + 1;

      const v1 = current.card.value;
      const v2 = next.card.value;

      let diff = v2 - v1;
      let validStep = false;
      let stepDirectionIsAscending = true;

      if (Math.abs(diff) === requiredGap) {
        validStep = true;
        stepDirectionIsAscending = diff > 0;
      }

      if (!validStep && (v1 === 1 || v2 === 1)) {
        const v1High = v1 === 1 ? 14 : v1;
        const v2High = v2 === 1 ? 14 : v2;
        const diffHigh = v2High - v1High;

        if (Math.abs(diffHigh) === requiredGap) {
          validStep = true;
          stepDirectionIsAscending = diffHigh > 0;
        }
      }

      if (!validStep) return false;

      if (isAscending === null) {
        isAscending = stepDirectionIsAscending;
      } else if (isAscending !== stepDirectionIsAscending) {
        return false;
      }
    }

    return true;
  }

  // =========================================================================
  // UTILITY METHODS
  // =========================================================================

  private isJoker(card: Card): boolean {
    return card.suit === "JOKER_RED" || card.suit === "JOKER_BLACK";
  }

  private getCardPoints(card: Card): number {
    if (this.isJoker(card)) return 0;
    if (card.value === 1) return 10;
    if (card.value >= 2 && card.value <= 10) return card.value;
    if (card.value >= 11 && card.value <= 13) return 10;
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