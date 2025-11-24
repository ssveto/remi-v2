import * as Phaser from "phaser";
import { ASSET_KEYS, CARD_HEIGHT, CARD_WIDTH, SCENE_KEYS } from "./common";
import { Remi, type MeldValidationResult } from "../lib/remi";
import type { Card } from "../lib/card";
import { GameEventType, GamePhase, type CardAddedToMeldEvent, type CardDiscardedEvent, type CardDrawnEvent, type DrawPileShuffledEvent, type GameOverEvent, type GameStartedEvent, type MeldsLaidDownEvent, type MeldValidationResultEvent, type PhaseChangedEvent, type PlayerTurnStartedEvent, type TurnEndedEvent } from "../lib/game-event";
import { AIPlayer, AIDifficulty } from "../lib/ai-player";

const DEBUG = false;
const SCALE = 1;
const CARD_BACK_FRAME = 54;

const SUIT_FRAMES = {
  HEART: 26,
  DIAMOND: 13,
  SPADE: 39,
  CLUB: 0,
  JOKER_RED: 52,
  JOKER_BLACK: 53,
} as const;

const LAYOUT = {
  MAX_HAND_WIDTH: 570 * 2,
  CARD_SPACING: 38 * 2,
  MIN_SCALE: 0.4,
  MAX_CARDS_IN_HAND: 15,
  PLAYER_HAND: { x: 30 * 2, y: 290 * 2 },
  DISCARD_PILE: { x: 370 * 2, y: 130 * 2 },
  DRAW_PILE: { x: 210 * 2, y: 130 * 2 },
  DISCARD_DROP_ZONE_PADDING: 75,
  DRAW_ZONE_OFFSET: 10,
  ANIMATION_DURATION: 100,
  // MELD_TABLE: {
  //   START_X: 300,
  //   START_Y: 450, // Below the hand
  //   MELD_SPACING_X: 50, // Space between melds horizontally
  //   MELD_SPACING_Y: 100, // Space between rows of melds
  //   CARD_SPACING_IN_MELD: 25, // Overlap cards in same meld
  //   // MAX_MELDS_PER_ROW: 3,
  // },
  DROP_ZONE_EXPANSION: 60,
} as const;

const MELD_CONFIG = {
  // Position above hand
  START_X: 300,
  START_Y: 420,  // Above hand area

  // Spacing
  CARD_OVERLAP: 25,      // Cards overlap in same meld
  MELD_SPACING: 180,     // Space between melds
  ROW_SPACING: 100,      // Space between rows (if needed)
  MAX_MELDS_PER_ROW: 5,  // Fit 5 melds per row

  // Appearance
  CARD_SCALE: 0.9,      // Smaller than hand cards
  DROP_ZONE_PADDING: 25, // Extra space for drop zones

  // Animation
  ANIMATION_DURATION: 400,
  STAGGER_DELAY: 50,     // Delay between card animations
} as const;

interface PlayerMeld {
  meldIndex: number;                      // Index in logic layer
  meldOwner: number;
  cards: Phaser.GameObjects.Image[];     // Visual cards
  cardData: Card[];                      // Actual card data
  position: { x: number; y: number };    // Base position
  dropZone: Phaser.GameObjects.Zone;     // Drop zone for adding cards
  highlight: Phaser.GameObjects.Rectangle; // Visual feedback
}

type ZoneType = keyof typeof ZONE_TYPE;
const ZONE_TYPE = {
  DISCARD: "DISCARD",
  CARDS_IN_HAND: "CARDS_IN_HAND",
  MELD_TABLE: "MELD_TABLE",
} as const;

/**
 * ARCHITECTURE DECISION:
 * GameScene is NOW just a visual layer - no game logic!
 * - Subscribes to events from RemiLogic
 * - Calls RemiLogic methods for user actions
 * - Manages Phaser objects only
 * - Never directly modifies game state
 */

// Example integration in your GameScene:

export class GameScene extends Phaser.Scene {
  #logic!: Remi;
  #ai!: AIPlayer;
  #cardsInHand: Phaser.GameObjects.Image[] = [];
  #selectedCards: Set<Phaser.GameObjects.Image> = new Set();
  #drawPileCards!: Phaser.GameObjects.Image[];
  #dropZonesInHand!: Phaser.GameObjects.Zone[];
  #discardPileCard!: Phaser.GameObjects.Image;
  #phaseIndicator!: Phaser.GameObjects.Text;
  #drawPileVisuals!: Phaser.GameObjects.Image[];
  #currentValidation: MeldValidationResult | null = null;
  #meldScoreText!: Phaser.GameObjects.Text;
  #meldButton!: Phaser.GameObjects.Container;
  #playerIcons: Phaser.GameObjects.Container[] = [];
  #currentViewingPlayer: number = 0; // 0 = viewing own melds
  #meldViewContainer: Phaser.GameObjects.Container | null = null;
  #allPlayerMelds: Map<number, PlayerMeld[]> = new Map();

  constructor() {
    super({ key: SCENE_KEYS.GAME });
  }

  public create(): void {
    // Create logic instance
    this.#logic = new Remi();

    // Subscribe to ALL events we care about
    this.#setupEventListeners();

    this.#cardsInHand = [];
    this.#selectedCards = new Set();
    this.#dropZonesInHand = [];

    // Start game
    this.#logic.newGame(3);
    this.#ai = new AIPlayer({
      difficulty: AIDifficulty.MEDIUM,
      thinkDelay: 800,
      randomness: 0.2,
    });

    this.#createDropZoneForDiscard();


    // Initialize meld storage for all players
    for (let i = 0; i < this.#logic.getState().numPlayers; i++) {
      this.#allPlayerMelds.set(i, []);
    }

    this.#createMeldScoreDisplay();
    this.#createMeldButton();
    this.#createPhaseIndicator();
    this.#createDragEvents();
    this.#createPlayerIcons();
  }

  #createDragEvents(): void {
    this.input.on(Phaser.Input.Events.DRAG_START,
      (pointer: Phaser.Input.Pointer, gameObject: Phaser.GameObjects.Image) => {
        this.#onDragStart(gameObject);
      }
    );

    this.input.on(Phaser.Input.Events.DRAG,
      (pointer: Phaser.Input.Pointer, gameObject: Phaser.GameObjects.Image, dragX: number, dragY: number) => {
        gameObject.setPosition(dragX, dragY);
      }
    );

    this.input.on(Phaser.Input.Events.DRAG_END,
      (pointer: Phaser.Input.Pointer, gameObject: Phaser.GameObjects.Image) => {
        this.#onDragEnd(gameObject);
      }
    );

    this.input.on(Phaser.Input.Events.DROP,
      (pointer: Phaser.Input.Pointer, gameObject: Phaser.GameObjects.Image, dropZone: Phaser.GameObjects.Zone) => {
        this.#onDrop(gameObject, dropZone);
      }
    );
  }

  #onDragStart(gameObject: Phaser.GameObjects.Image): void {
    // Store original position for snap-back
    gameObject.setData('origX', gameObject.x);
    gameObject.setData('origY', gameObject.y);
    gameObject.setDepth(1000); // Bring to front
  }

  #onDragEnd(gameObject: Phaser.GameObjects.Image): void {
    gameObject.setDepth(0);

    // If not dropped in valid zone, snap back
    if (!gameObject.getData('wasDropped')) {
      gameObject.setPosition(
        gameObject.getData('origX') as number,
        gameObject.getData('origY') as number
      );
    }

    gameObject.setData('wasDropped', false);
  }

  #onDrop(gameObject: Phaser.GameObjects.Image, dropZone: Phaser.GameObjects.Zone): void {
    gameObject.setData('wasDropped', true);

    const zoneType = dropZone.getData('zoneType') as ZoneType;

    if (zoneType === ZONE_TYPE.CARDS_IN_HAND) {
      // Reorder card in hand
      const targetIndex = dropZone.getData('positionIndex') as number;
      const currentIndex = this.#cardsInHand.indexOf(gameObject);

      if (currentIndex === targetIndex) {
        // It's good practice to snap the card back to its original position
        // even if no reordering happens.
        this.#updateCardsInHand();
        return;
      }

      if (currentIndex !== -1 && currentIndex !== targetIndex) {
        // Update logic layer
        this.#logic.reorderHand(0, currentIndex, targetIndex);

        // Update visual layer
        const [movedCard] = this.#cardsInHand.splice(currentIndex, 1);
        this.#cardsInHand.splice(targetIndex, 0, movedCard);

        this.#updateCardsInHand();
        this.#updateDropZonesForHand();
      }
    } else if (zoneType === ZONE_TYPE.DISCARD) {

      if (this.#logic.getState().phase === GamePhase.DRAW) {
        this.#showMessage("Vuci kartu prvo!");
        gameObject.setPosition(
          gameObject.getData('origX') as number,
          gameObject.getData('origY') as number
        );
        return;
      }
      // Discard card
      //const card = gameObject.getData('cardId') as Card;
      const card = this.#getCardFromGameObject(gameObject);

      if (!card) {
        console.error('Cannot find card for discard');
        gameObject.setPosition(
          gameObject.getData('origX') as number,
          gameObject.getData('origY') as number
        );
        return;
      }

      const success = this.#logic.discardCard(0, card);

      if (!success) {
        // Snap back if discard failed
        gameObject.setPosition(
          gameObject.getData('origX') as number,
          gameObject.getData('origY') as number
        );
      }

    } else if (zoneType === ZONE_TYPE.MELD_TABLE) {
      this.#handleDropOnMeldTable(gameObject, dropZone)
    }
  }

  #createPlayerIcons(): void {
    const iconSize = 50;
    const spacing = 70;
    const startX = this.scale.width - 80;
    const startY = 80;

    const numPlayers = this.#logic.getState().numPlayers;

    for (let i = 1; i < numPlayers; i++) {
      const y = startY + (i - 1) * spacing;

      // Background circle
      const circle = this.add
        .circle(0, 0, iconSize / 2, 0x666666, 1)
        .setStrokeStyle(3, 0x333333);

      // Player number
      const text = this.add
        .text(0, 0, `P${i + 1}`, {
          fontSize: "20px",
          fontFamily: "Arial",
          color: "#ffffff",
          fontStyle: "bold",
        })
        .setOrigin(0.5);

      // Card count text (shows hand size)
      const cardCount = this.add
        .text(0, iconSize / 2 + 10, "14", {
          fontSize: "12px",
          fontFamily: "Arial",
          color: "#ffffff",
        })
        .setOrigin(0.5);

      // Meld indicator (small green dot, hidden by default)
      const indicator = this.add
        .circle(iconSize / 3, -iconSize / 3, 8, 0x00ff00, 1)
        .setStrokeStyle(2, 0xffffff)
        .setVisible(false);

      // Container for all elements
      const container = this.add.container(startX, y, [
        circle,
        text,
        cardCount,
        indicator,
      ]);

      // Make interactive
      circle.setInteractive({ useHandCursor: true });

      circle.on("pointerover", () => {
        circle.setFillStyle(0x888888);
      });

      circle.on("pointerout", () => {
        circle.setFillStyle(0x666666);
      });

      circle.on("pointerdown", () => {
        this.#viewPlayerMelds(i);
      });

      this.#playerIcons[i] = container;
    }
  }

  #viewPlayerMelds(playerIndex: number): void {
    if (playerIndex === 0) {
      this.#showMessage("Your melds are always visible on the table");
      return;
    }

    if (!this.#logic.hasPlayerOpened(playerIndex)) {
      this.#showMessage(`Player ${playerIndex + 1} has no melds yet`);
      return;
    }

    // Toggle view
    if (this.#currentViewingPlayer === playerIndex && this.#meldViewContainer) {
      this.#closeMeldView();
      return;
    }

    if (this.#meldViewContainer) {
      this.#closeMeldView();
    }

    this.#currentViewingPlayer = playerIndex;
    this.#showMeldView(playerIndex);
  }

  #showMeldView(playerIndex: number): void {
    const playerMelds = this.#allPlayerMelds.get(playerIndex);
    if (!playerMelds || playerMelds.length === 0) return;

    this.#closeMeldView();
    this.#currentViewingPlayer = playerIndex;
    this.#meldViewContainer = this.add.container(0, 0);

    const START_X = 300;
    const START_Y = 100;
    const CARD_OVERLAP = 25;
    const MELD_SPACING = 50;

    playerMelds.forEach((meld, meldIdx) => {
      const baseX = START_X + meldIdx * MELD_SPACING;

      meld.cardData.forEach((card, cardIdx) => {
        const cardImage = this.add
          .image(
            baseX + cardIdx * CARD_OVERLAP,
            START_Y,
            ASSET_KEYS.CARDS,
            this.#getCardFrame(card)
          )
          .setOrigin(0)
          .setScale(SCALE * 0.9)
          .setDepth(10 + cardIdx);

        this.#meldViewContainer?.add(cardImage);
      });
    });

    // // Add semi-transparent background
    // const bg = this.add
    //   .rectangle(0, 0, this.scale.width, 200, 0x000000, 0.7)
    //   .setOrigin(0)
    //   .setDepth(999)
    //   .setInteractive();

    // bg.on('pointerdown', () => this.#closeMeldView());

    // this.#meldViewContainer?.addAt(bg, 0);
  }

  #closeMeldView(): void {
    if (this.#meldViewContainer) {
      this.#meldViewContainer.destroy();
      this.#meldViewContainer = null;
    }
    this.#currentViewingPlayer = 0;
  }

  #updatePlayerIconStatus(playerIndex: number, hasMelds: boolean): void {
    if (playerIndex === 0) return;

    const icon = this.#playerIcons[playerIndex];
    if (!icon) return;

    const indicator = icon.getAt(3) as Phaser.GameObjects.Arc;
    indicator.setVisible(hasMelds);
  }

  #createPhaseIndicator(): void {
    this.#phaseIndicator = this.add
      .text(80, 100, 'DRAW CARD', {
        fontSize: '18px',
        fontFamily: 'Arial',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
  }

  #setupEventListeners(): void {
    // Game start
    this.#logic.on(GameEventType.GAME_STARTED, (event) => {
      this.#onGameStarted(event as GameStartedEvent);
    });

    // Card movement
    this.#logic.on(GameEventType.CARD_DRAWN_FROM_DECK,
      (e) => this.#onCardDrawn(e as CardDrawnEvent));
    // this.#logic.on(GameEventType.CARD_DRAWN_FROM_DISCARD,
    //   (e) => this.#onCardDrawnFromDiscard(e as CardDrawnEvent));
    this.#logic.on(GameEventType.CARD_DISCARDED,
      (e) => this.#onCardDiscarded(e as CardDiscardedEvent));

    // Meldsc
    this.#logic.on(GameEventType.MELDS_LAID_DOWN,
      (e) => this.#onMeldsLaidDown(e as MeldsLaidDownEvent));
    this.#logic.on(GameEventType.CARD_ADDED_TO_MELD,
      (e) => this.#onCardAddedToMeld(e as CardAddedToMeldEvent));
    this.#logic.on(GameEventType.MELD_VALIDATION_RESULT,
      (e) => this.#onMeldValidation(e as MeldValidationResultEvent));

    // Turn management
    this.#logic.on(GameEventType.PHASE_CHANGED,
      (e) => this.#onPhaseChanged(e as PhaseChangedEvent));
    this.#logic.on(GameEventType.TURN_ENDED,
      (e) => this.#onTurnEnded(e as TurnEndedEvent));
    this.#logic.on(GameEventType.PLAYER_TURN_STARTED,
      (e) => this.#onPlayerTurnStarted(e as PlayerTurnStartedEvent));

    // Deck changes
    this.#logic.on(GameEventType.DRAW_PILE_SHUFFLED,
      (e) => this.#onDrawPileShuffled(e as DrawPileShuffledEvent));

    // Game end
    this.#logic.on(GameEventType.GAME_OVER,
      (e) => this.#onGameOver(e as GameOverEvent));
  }

  // Event handlers - update visuals only
  #onGameStarted(event: GameStartedEvent): void {
    // Create initial visual elements
    this.#createDrawPile();
    this.#createDiscardPile();
    this.#createPlayerHandVisuals();
  }

  #createPlayerHandVisuals(): void {
    this.#cardsInHand = [];
    const humanPlayerHand = this.#logic.getPlayerHand(0)
    humanPlayerHand.forEach((card, cardIndex) => {
      const cardGO = this.#createCard(
        LAYOUT.PLAYER_HAND.x + cardIndex * 38,
        LAYOUT.PLAYER_HAND.y,
        card.isFaceUp,
        cardIndex
      ).setData({
        cardIndex: cardIndex,
        zoneType: ZONE_TYPE.CARDS_IN_HAND,
        cardId: card.id,
        //originalY: LAYOUT.PLAYER_HAND.y,
        isSelected: false,
      });
      this.#cardsInHand.push(cardGO);
      if (card.isFaceUp) {
        this.input.setDraggable(
          cardGO,
          !cardGO.getData("isSelected")
        );

        cardGO.setFrame(this.#getCardFrame(card));
        this.#makeCardSelectable(cardGO);
      }
    });
    this.#updateCardsInHand();
    this.#updateDropZonesForHand();
  }

  #makeCardSelectable(cardGO: Phaser.GameObjects.Image): void {
    let pointerDownTime = 0;
    let pointerDownPos = { x: 0, y: 0 };

    cardGO.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      pointerDownTime = this.time.now;
      pointerDownPos = { x: pointer.x, y: pointer.y };
    });

    cardGO.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      const distance = Phaser.Math.Distance.Between(
        pointerDownPos.x, pointerDownPos.y,
        pointer.x, pointer.y
      );
      const duration = this.time.now - pointerDownTime;

      // If quick click (not drag), toggle selection
      if (distance < 10 && duration < 300) {
        this.#toggleCardSelection(cardGO);
      }
    });
  }

  #onMeldValidation(event: MeldValidationResultEvent): void {
    // This is called when logic validates melds
    // Usually for debugging/logging
    console.log('Meld validation:', event);
  }

  #toggleCardSelection(cardGO: Phaser.GameObjects.Image): void {
    // Update visual selection state
    //const cardRef = cardGO.getData("cardRef") as Card;

    const cardRef = this.#getCardFromGameObject(cardGO);

    if (cardRef === null) {
      return;
    }

    if (this.#selectedCards.has(cardGO)) {
      const meldContainingCard = this.#findMeldContainingCard(cardRef);

      if (meldContainingCard) {
        this.#deselectEntireMeld(meldContainingCard);
      } else {
        this.#selectedCards.delete(cardGO);
        this.#animateCardDeselect(cardGO);
        this.input.setDraggable(cardGO, true);
      }

    } else {
      this.#selectedCards.add(cardGO);
      this.#animateCardSelect(cardGO);
      this.input.setDraggable(cardGO, false);
    }

    // Ask logic to validate current selection
    this.#validateCurrentSelection();
  }

  #deselectEntireMeld(meld: Card[]): void {
    // Find all game objects corresponding to cards in this meld
    meld.forEach((card) => {
      const cardGO = this.#cardsInHand.find(
        (go) => go.getData("cardId") === card.id
      );

      if (cardGO && this.#selectedCards.has(cardGO)) {
        this.#animateCardDeselect(cardGO);
        this.#selectedCards.delete(cardGO);
        this.input.setDraggable(cardGO, true);
      }
    });
  }

  #findMeldContainingCard(card: Card): Card[] | null {
    // Check if this card is part of any current valid meld
    const currentMelds = this.#logic.getCurrentMelds();

    for (const meld of currentMelds) {
      if (meld.includes(card)) {
        return meld;
      }
    }
    return null;
  }

  /**
   * Request validation from logic and update UI.
   * WHY: This is where visual and logic layers communicate!
   */
  #validateCurrentSelection(): void {
    // Get selected cards in hand order
    const selectedCardRefs = this.#getSelectedCardsInOrder();

    // Ask logic layer for validation resulta
    this.#currentValidation = this.#logic.validateMelds(0, selectedCardRefs);

    // Update UI based on result
    this.#updateMeldVisualFeedback(this.#currentValidation);
    this.#updateMeldScore();
    this.#updateMeldButton();
  }

  /**
   * Get selected cards in hand position order (not selection order).
   * WHY: Meld validation needs cards in logical order.
   */
  #getSelectedCardsInOrder(): Card[] {
    const selectedWithIndices: Array<{ card: Card; index: number }> = [];

    this.#cardsInHand.forEach((cardGO, handIndex) => {
      if (this.#selectedCards.has(cardGO)) {
        const card = this.#getCardFromGameObject(cardGO);

        if (card) {
          selectedWithIndices.push({ card, index: handIndex });
        }
      }
    });

    // Sort by hand position
    selectedWithIndices.sort((a, b) => a.index - b.index);

    return selectedWithIndices.map(item => item.card);
  }

  /**
   * Update visual feedback based on validation result.
   * WHY: Different colors for valid melds, invalid cards, etc.
   */
  #updateMeldVisualFeedback(result: MeldValidationResult): void {
    // Create card â†’ meld mapping
    const cardIdToMeld = new Map<string, number>();
    result.validMelds.forEach((meld, meldIndex) => {
      meld.forEach(card => cardIdToMeld.set(card.id, meldIndex));
    });

    // Colors for different melds
    const meldColors = [
      0x00ff00, // Green - first meld
      0x00ffff, // Cyan - second meld
      0xff00ff, // Magenta - third meld
      0xffff00, // Yellow - fourth meld
    ];

    // Update each selected card's visual
    this.#selectedCards.forEach(cardGO => {
      const card = this.#getCardFromGameObject(cardGO);
      if (!card) return;

      const meldIndex = cardIdToMeld.get(card.id);

      if (meldIndex !== undefined) {
        // Card is in a valid meld
        const color = meldColors[meldIndex % meldColors.length];
        cardGO.setTint(color);
      } else {
        // Card is invalid (selected but not in any meld)
        cardGO.setTint(0xFFFFC5); // Red
      }
    });
  }

  /**
   * Update score display based on validation result.
   */
  #updateMeldScore(): void {
    // Update score text
    let totalScore = this.#logic.currentScore();
    this.#meldScoreText.setText(`${totalScore}`);

    const playerMelds = this.#allPlayerMelds.get(0) || [];

    // Color based on requirement
    if (totalScore === 0) {
      this.#meldScoreText.setColor('#ffffff'); // White
    } else if (totalScore >= 51 || playerMelds.length > 1) {
      this.#meldScoreText.setColor('#00ff00'); // Green - good!
    } else {
      this.#meldScoreText.setColor('#ff0000'); // Red - not enough

      // Show how many more points needed
      // this.#showHint(
      //   `Need ${result.minimumNeeded} more points to open!`
      // );
    }
  }

  /**
   * Update meld button visibility and state.
   */
  #updateMeldButton(): void {
    /*const shouldShow =
      result.validMelds.length > 0 &&
      result.meetsOpenRequirement; */

    const shouldShow = (!this.#logic.hasPlayerOpened(0) && this.#logic.currentScore() >= 51) || (this.#logic.hasPlayerOpened(0) && this.#logic.getCurrentMelds().length > 0);

    this.#meldButton.setVisible(shouldShow);

    // Update button text
    const buttonText = this.#meldButton.getAt(1) as Phaser.GameObjects.Text;
    buttonText.setText('Izbaci karte!');

  }

  /**
   * Handle meld button click.
   * WHY: Use validated result to lay down melds.
   */
  #onMeldButtonClick(): void {
    if (!this.#currentValidation) return;
    // if (!this.#currentValidation.meetsOpenRequirement) return;

    if (!this.#logic.hasPlayerOpened(0) && this.#logic.currentScore() < 51) return;
    if (this.#logic.hasPlayerOpened(0) && this.#logic.getCurrentMelds().length === 0) return;


    // Use the already-validated melds!
    const success = this.#logic.layDownMelds(
      0,
      this.#currentValidation.validMelds
    );

    const state = this.#logic.getState();
    if (state.phase === GamePhase.DRAW) {
      this.#showMessage("Draw a card first!");
      return;
    }

    if (success) {
      // Clear selection (visual state)
      this.#selectedCards.clear();
      this.#currentValidation = null;
      this.#updateMeldButton();
      this.#updateMeldScore();
      // Event handler will update visuals
    }
  }

  #onCardAddedToMeld(event: CardAddedToMeldEvent): void {
    if (event.playerIndex !== 0) {
      // AI player - ignore for now
      return;
    }

    const playerMelds = this.#allPlayerMelds.get(event.playerIndex) || [];
    // Find the meld
    const meld = playerMelds.find(m => m.meldIndex === event.meldIndex);
    if (!meld) {
      console.error('Meld not found:', event.meldIndex);
      console.error('Available melds:', playerMelds.map(m => m.meldIndex));
      return;
    }

    // Find card in hand
    const handIndex = this.#cardsInHand.findIndex(
      go => go.getData('cardId') === event.card.id
    );

    if (handIndex === -1) {
      console.error('Card not found in hand:', event.card.toString());
      return;
    }

    const cardGO = this.#cardsInHand[handIndex];
    this.#cardsInHand.splice(handIndex, 1);

    // Add to meld visually
    this.#addCardToMeldDisplay(meld, cardGO, event.card);

    // Update hand
    this.#updateCardsInHand();
    this.#updateDropZonesForHand();

    this.#showMessage('Card added to meld!');
  }

  #addCardToMeldDisplay(
    meld: PlayerMeld,
    cardGO: Phaser.GameObjects.Image,
    card: Card
  ): void {
    // Calculate new position at end of meld
    const cardIndex = meld.cards.length;
    const finalX = meld.position.x + cardIndex * MELD_CONFIG.CARD_OVERLAP;
    const finalY = meld.position.y;

    // Clear any selection state
    cardGO.clearTint();
    cardGO.setData('isSelected', false);
    this.#selectedCards.delete(cardGO);

    // Animate to position
    this.tweens.add({
      targets: cardGO,
      x: finalX,
      y: finalY,
      scale: SCALE * MELD_CONFIG.CARD_SCALE,
      rotation: 0,
      duration: 300,
      ease: 'Back.easeOut',
      onStart: () => {
        cardGO.setDepth(200 + cardIndex);
      },
      onComplete: () => {
        this.#disableCardInteraction(cardGO);
      }
    });

    // Update meld data
    meld.cards.push(cardGO);
    meld.cardData.push(card);

    // Recreate drop zone with new size
    meld.dropZone.destroy();
    meld.highlight.destroy();

    this.time.delayedCall(350, () => {
      const { dropZone, highlight } = this.#createMeldDropZone(
        meld.position,
        meld.cards.length,
        meld.meldIndex,
        meld.meldOwner
      );

      meld.dropZone = dropZone;
      meld.highlight = highlight;
    });
  }

  #handleDropOnMeldTable(
    cardGO: Phaser.GameObjects.Image,
    dropZone: Phaser.GameObjects.Zone
  ): void {
    const meldIndex = dropZone.getData('meldIndex') as number;
    const meldOwner = dropZone.getData('playerIndex') as number;
    const card = this.#getCardFromGameObject(cardGO);

    if (!card) {
      console.error('Cannot find card');
      cardGO.setPosition(
        cardGO.getData('origX') as number,
        cardGO.getData('origY') as number
      );
      return;
    }

    // Validate with logic layer
    const success = this.#logic.addCardToMeld(
      0,           // player index
      card,        // card to add
      meldOwner,           // meld owner
      meldIndex    // which meld
    );

    if (!success) {
      // Invalid - snap back
      this.#showMessage('Card doesn\'t fit in this meld!');
      cardGO.setPosition(
        cardGO.getData('origX') as number,
        cardGO.getData('origY') as number
      );
    }
    // If successful, event handler will update visuals
  }

  #disableCardInteraction(cardGO: Phaser.GameObjects.Image): void {
    // Remove all listeners
    cardGO.removeAllListeners();

    // Disable interactive
    cardGO.disableInteractive();

    // Not draggable
    this.input.setDraggable(cardGO, false);

    // Clear data flags
    cardGO.setData('isSelected', false);
    cardGO.setData('zoneType', ZONE_TYPE.MELD_TABLE);
  }

  #displayPlayerMelds(playerIndex: number, newMelds: Card[][]): void {
    // If player 0 (human), display on main table
    if (playerIndex === 0) {
      this.#displayHumanMelds(newMelds);
      return;
    }

    // For AI players, just store the data and update icon
    const playerMelds = this.#allPlayerMelds.get(playerIndex) || [];
    const startMeldIndex = playerMelds.length;

    newMelds.forEach((meldCards, offset) => {
      const meldIndex = startMeldIndex + offset;

      // Store meld data (no visuals yet)
      const aiMeld: PlayerMeld = {
        meldIndex,
        meldOwner: playerIndex,
        cards: [], // No visual cards until viewed
        cardData: [...meldCards],
        position: { x: 0, y: 0 }, // Calculated when viewed
        dropZone: null as any, // Created when viewed
        highlight: null as any,
      };

      playerMelds.push(aiMeld);
    });

    this.#allPlayerMelds.set(playerIndex, playerMelds);
    this.#updatePlayerIconStatus(playerIndex, true);
  }


  #displayHumanMelds(newMelds: Card[][]): void {
    const playerMelds = this.#allPlayerMelds.get(0) || [];

    const allLogicMelds = this.#logic.getPlayerMelds(0);

    const startLogicIndex = allLogicMelds.length - newMelds.length;

    newMelds.forEach((meldCards, offset) => {
      const logicMeldIndex = startLogicIndex + offset;

      const position = this.#calculateMeldPosition(logicMeldIndex);

      // Collect card GameObjects
      const cardGOs: Phaser.GameObjects.Image[] = [];

      // STEP 1: Find all cards and their indices (don't modify array yet)
      const cardsToRemove: Array<{ index: number; cardGO: Phaser.GameObjects.Image }> = [];

      meldCards.forEach((card) => {
        const handIndex = this.#cardsInHand.findIndex(
          go => go.getData('cardId') === card.id
        );

        if (handIndex === -1) {
          console.error('Card not found in hand:', card.toString());
          return;
        }

        const cardGO = this.#cardsInHand[handIndex];
        cardsToRemove.push({ index: handIndex, cardGO });
      });

      // STEP 2: Remove from hand in reverse order (so indices stay valid)
      cardsToRemove
        .sort((a, b) => b.index - a.index) // Sort descending by index
        .forEach(({ cardGO }) => {
          const currentIndex = this.#cardsInHand.indexOf(cardGO);
          if (currentIndex !== -1) {
            this.#cardsInHand.splice(currentIndex, 1);
          }
        });

      const { dropZone, highlight } = this.#createMeldDropZone(
        position,
        meldCards.length,
        logicMeldIndex,
        0
      );

      // Store meld display
      const playerMeld: PlayerMeld = {
        meldIndex: logicMeldIndex,
        meldOwner: 0,
        cards: cardGOs,
        cardData: [...meldCards],
        position,
        dropZone,
        highlight,
      };

      playerMelds.push(playerMeld);
      this.#allPlayerMelds.set(0, playerMelds)

      // STEP 3: Process each card for animation
      cardsToRemove.forEach(({ cardGO }, cardIndex) => {
        // Clean up card state
        cardGO.clearTint();
        cardGO.setData('isSelected', false);
        this.#selectedCards.delete(cardGO);

        // Calculate final position
        const finalX = position.x + cardIndex * MELD_CONFIG.CARD_OVERLAP;
        const finalY = position.y;

        // Animate to meld position
        const delay = offset * 200 + cardIndex * MELD_CONFIG.STAGGER_DELAY;

        this.tweens.add({
          targets: cardGO,
          x: finalX,
          y: finalY,
          scale: SCALE * MELD_CONFIG.CARD_SCALE,
          rotation: 0,
          duration: MELD_CONFIG.ANIMATION_DURATION,
          delay,
          ease: 'Back.easeOut',
          onStart: () => {
            cardGO.setDepth(100 + cardIndex); // Above hand
          },
          onComplete: () => {
            // Disable all interaction
            this.#disableCardInteraction(cardGO);
          }
        });

        cardGOs.push(cardGO);
      });

      // Create drop zone after animation completes
      const dropZoneDelay = offset * 200 + meldCards.length * MELD_CONFIG.STAGGER_DELAY + 100;

      this.time.delayedCall(dropZoneDelay, () => {
        console.log('🎬 Animation complete for meld', logicMeldIndex);
      });
    });
  }

  #calculateMeldPosition(meldIndex: number): { x: number; y: number } {
    const row = Math.floor(meldIndex / MELD_CONFIG.MAX_MELDS_PER_ROW);
    const col = meldIndex % MELD_CONFIG.MAX_MELDS_PER_ROW;

    return {
      x: MELD_CONFIG.START_X + col * MELD_CONFIG.MELD_SPACING,
      y: MELD_CONFIG.START_Y + row * MELD_CONFIG.ROW_SPACING,
    };
  }

  #createMeldDropZone(
    position: { x: number; y: number },
    cardCount: number,
    meldIndex: number,
    meldOwner: number,
  ): { dropZone: Phaser.GameObjects.Zone; highlight: Phaser.GameObjects.Rectangle } {
    // Calculate zone size based on meld length
    const meldWidth =
      CARD_WIDTH * MELD_CONFIG.CARD_SCALE +
      (cardCount - 1) * MELD_CONFIG.CARD_OVERLAP;

    const zoneWidth = meldWidth + MELD_CONFIG.DROP_ZONE_PADDING * 2;
    const zoneHeight = CARD_HEIGHT * MELD_CONFIG.CARD_SCALE + MELD_CONFIG.DROP_ZONE_PADDING * 2;

    const zoneX = position.x - MELD_CONFIG.DROP_ZONE_PADDING;
    const zoneY = position.y - MELD_CONFIG.DROP_ZONE_PADDING;

    // Create drop zone
    const dropZone = this.add.zone(zoneX, zoneY, zoneWidth, zoneHeight)
      .setOrigin(0)
      .setRectangleDropZone(zoneWidth, zoneHeight)
      .setData({
        zoneType: ZONE_TYPE.MELD_TABLE,
        meldIndex,
        playerIndex: meldOwner,
      })
      .setDepth(150);

    // Create highlight (hidden by default)
    const highlight = this.add.rectangle(zoneX, zoneY, zoneWidth, zoneHeight, 0x4caf50, 0)
      .setOrigin(0)
      .setDepth(150)
      .setStrokeStyle(2, 0x4caf50, 0);

    // Show highlight on drag enter
    this.input.on('dragenter',
      (_p: Phaser.Input.Pointer, _go: Phaser.GameObjects.GameObject, zone: Phaser.GameObjects.Zone) => {
        if (zone === dropZone) {
          highlight.setAlpha(0.2);
          highlight.setStrokeStyle(2, 0x4caf50, 1);
        }
      }
    );

    // Hide highlight on drag leave
    this.input.on('dragleave',
      (_p: Phaser.Input.Pointer, _go: Phaser.GameObjects.GameObject, zone: Phaser.GameObjects.Zone) => {
        if (zone === dropZone) {
          highlight.setAlpha(0);
          highlight.setStrokeStyle(2, 0x4caf50, 0);
        }
      }
    );

    // Clear highlight on drop
    dropZone.on('drop', () => {
      highlight.setAlpha(0);
      highlight.setStrokeStyle(2, 0x4caf50, 0);
    });

    // Debug visualization
    if (DEBUG) {
      this.add.rectangle(zoneX, zoneY, zoneWidth, zoneHeight, 0x00ff00, 0.2)
        .setOrigin(0)
        .setDepth(151);
    }

    return { dropZone, highlight };
  }


  #animateCardSelect(cardGO: Phaser.GameObjects.Image): void {
    this.tweens.add({
      targets: cardGO,
      y: LAYOUT.PLAYER_HAND.y - 10,
      scale: SCALE * 1.05,
      duration: 150,
      ease: 'Back.easeOut',
    });
  }

  #animateCardDeselect(cardGO: Phaser.GameObjects.Image): void {
    this.tweens.add({
      targets: cardGO,
      y: LAYOUT.PLAYER_HAND.y,
      scale: SCALE,
      duration: 150,
      ease: 'Back.easeOut',
    });
    cardGO.clearTint();
  }

  #showHint(message: string): void {
    // Show temporary tooltip near meld button
    const hint = this.add.text(
      this.#meldButton.x,
      this.#meldButton.y - 40,
      message,
      {
        fontSize: '14px',
        color: '#ff6b6b',
        backgroundColor: '#2c3e50',
        padding: { x: 10, y: 5 },
      }
    )
      .setOrigin(0.5);

    this.tweens.add({
      targets: hint,
      alpha: 0,
      y: hint.y - 20,
      duration: 2000,
      ease: 'Power2',
      onComplete: () => hint.destroy(),
    });
  }


  #createDiscardPile(): void {
    this.#drawCardLocationBox(LAYOUT.DISCARD_PILE.x, LAYOUT.DISCARD_PILE.y, 40);
    this.#discardPileCard = this.#createCard(
      LAYOUT.DISCARD_PILE.x,
      LAYOUT.DISCARD_PILE.y,
      true
    ).setVisible(false);
  }

  #drawCardLocationBox(x: number, y: number, z: number): void {
    this.add
      .rectangle(x, y, CARD_WIDTH, CARD_HEIGHT)
      .setOrigin(0)
      .setStrokeStyle(2, 0x000000, 0.5);
  }

  #onCardDrawn(event: CardDrawnEvent): void {
    if (event.playerIndex === 0) {
      // Your existing human player code
      const cardGO = this.#createCardVisual(event.card);
      this.#cardsInHand.push(cardGO);
      this.#animateCardFromDeckToHand(cardGO, event.card);
    } else {
      // Update AI player icon
      this.#updatePlayerCardCount(event.playerIndex, event.handSize);
    }
  }

  #updatePlayerCardCount(playerIndex: number, handSize: number): void {
    if (playerIndex === 0) return;

    const icon = this.#playerIcons[playerIndex];
    if (!icon) return;

    const cardCount = icon.getAt(2) as Phaser.GameObjects.Text;
    cardCount.setText(`${handSize}`);
  }

  #createCardVisual(card: Card): Phaser.GameObjects.Image {
    const cardGO = this.add.image(
      LAYOUT.DRAW_PILE.x,
      LAYOUT.DRAW_PILE.y,
      ASSET_KEYS.CARDS,
      this.#getCardFrame(card)
    )
      .setOrigin(0)
      .setScale(SCALE)
      .setInteractive()
      .setData({
        cardId: card.id,
        isSelected: false,
      });

    if (card.isFaceUp) {
      this.input.setDraggable(cardGO);
      this.#makeCardSelectable(cardGO);
    }

    return cardGO;
  }

  #getCardById(cardId: string): Card | null {
    const hand = this.#logic.getPlayerHand(0);
    return hand.find(c => c.id === cardId) || null;
  }
  #getCardFromGameObject(cardGO: Phaser.GameObjects.Image): Card | null {
    const cardId = cardGO.getData('cardId') as string;
    if (!cardId) {
      console.error('Card GameObject missing cardId data');
      return null;
    }
    return this.#getCardById(cardId);
  }


  #animateCardFromDeckToHand(
    cardGO: Phaser.GameObjects.Image,
    card: Card
  ): void {


    this.tweens.add({
      targets: cardGO,
      x: this.scale.width / 2 - 50,
      y: LAYOUT.PLAYER_HAND.y - 170,
      duration: 300,
      ease: 'Back.easeOut',
      onStart: () => {
        cardGO.setDepth(30);
      },
      onComplete: () => {
        this.#updateCardsInHand();
        this.#updateDropZonesForHand();
      }
    });
  }

  #updateCardsInHand(): void {
    const layout = this.#calculateHandLayout();
    if (layout.numCards === 0) return;

    this.#cardsInHand.forEach((card, cardIndex) => {
      const finalX = layout.startX + cardIndex * layout.spacing;
      const isSelected = this.#selectedCards.has(card);

      this.tweens.add({
        targets: card,
        x: finalX,
        y: isSelected ? LAYOUT.PLAYER_HAND.y - 10 : LAYOUT.PLAYER_HAND.y,
        //scale: layout.scaleFactor,
        duration: LAYOUT.ANIMATION_DURATION,
        ease: "Sine.easeOut",
      });

      card.setData("cardIndex", cardIndex);
      card.setData("zoneType", ZONE_TYPE.CARDS_IN_HAND);
    });
  }

  #updateDropZonesForHand(): void {
    this.#dropZonesInHand.forEach((zone) => zone.destroy());
    this.#dropZonesInHand = [];

    const layout = this.#calculateHandLayout();
    if (layout.numCards === 0) return;

    this.#cardsInHand.forEach((card, cardIndex) => {
      const finalX = layout.startX + cardIndex * layout.spacing;

      let zone = this.add
        .zone(
          finalX,
          LAYOUT.PLAYER_HAND.y,
          CARD_WIDTH * layout.scaleFactor,
          CARD_HEIGHT * layout.scaleFactor
        )
        .setOrigin(0)
        .setRectangleDropZone(
          CARD_WIDTH * layout.scaleFactor,
          CARD_HEIGHT * layout.scaleFactor
        )
        .setData({
          zoneType: ZONE_TYPE.CARDS_IN_HAND,
          positionIndex: cardIndex,
        })
        .setDepth(-1);

      this.#dropZonesInHand.push(zone);
    });
  }

  #calculateHandLayout(): {
    startX: number;
    spacing: number;
    scaleFactor: number;
    numCards: number;
  } {
    const numCards = this.#cardsInHand.length;

    // If no cards, return defaults
    if (numCards === 0) {
      return {
        startX: LAYOUT.PLAYER_HAND.x,
        spacing: 0,
        scaleFactor: 1,
        numCards: 0,
      };
    }


    // Calculate how wide the hand would be without scaling
    const unscaledTotalWidth =
      CARD_WIDTH + (numCards - 1) * LAYOUT.CARD_SPACING;

    // Scale down if too wide, but never smaller than MIN_SCALE
    let scaleFactor = Math.min(1, LAYOUT.MAX_HAND_WIDTH / unscaledTotalWidth);
    scaleFactor = Math.max(scaleFactor, LAYOUT.MIN_SCALE);

    // Calculate actual width after scaling
    const scaledTotalWidth =
      CARD_WIDTH * scaleFactor +
      (numCards - 1) * (LAYOUT.CARD_SPACING * scaleFactor);

    // Center the hand by calculating empty space on sides
    const emptySpace = LAYOUT.MAX_HAND_WIDTH - scaledTotalWidth;
    const startX = LAYOUT.PLAYER_HAND.x + emptySpace / 2;
    const spacing = LAYOUT.CARD_SPACING * scaleFactor;

    return { startX, spacing, scaleFactor, numCards };
  }

  #onPlayerTurnStarted(event: PlayerTurnStartedEvent): void {
    if (event.playerIndex === 0) {
      // Human - wait for them to act
      this.#showMessage('Your turn!');
    } else {
      // AI - run after delay
      this.time.delayedCall(1000, () => this.#runAITurn());
    }
  }

  #onGameOver(event: GameOverEvent): void {
    const message = event.winner === 0
      ? "You win! ðŸŽ‰"
      : `Player ${event.winner + 1} wins!`;

    this.#showMessage(message);
    // Show final scores, play animation, etc.
  }

  #onDrawPileShuffled(event: DrawPileShuffledEvent): void {
    // Update visual card count
    const state = this.#logic.getState();
    const visibleCards = Math.min(state.drawPileSize, 3);

    this.#drawPileVisuals.forEach((card, i) => {
      card.setVisible(i < visibleCards);
    });

    this.#showMessage(`Deck shuffled! ${event.newDrawPileSize} cards`);
  }

  #onPhaseChanged(event: PhaseChangedEvent): void {
    const phaseText = {
      [GamePhase.DRAW]: "DRAW CARD",
      [GamePhase.MELD]: "MELD/DISCARD",
      [GamePhase.DISCARD]: "DISCARD",
      [GamePhase.GAME_OVER]: "GAME OVER",
    };

    if (this.#logic.getState().currentPlayer !== 0) {
      this.#phaseIndicator.setText("Computer");

    } else {
      this.#phaseIndicator.setText(phaseText[event.newPhase]);

    }

  }

  #onTurnEnded(event: TurnEndedEvent): void {
    if (event.nextPlayer !== 0) {
      // AI player's turn - trigger AI logic
      this.time.delayedCall(800, () => this.#runAITurn());
    }
  }

  #createMeldScoreDisplay(): void {
    this.#meldScoreText = this.add
      .text(80, 40, '0', {
        fontSize: '30px',
        fontFamily: 'Roboto',
        color: '#FFFFFF',
        stroke: '#000000',
        strokeThickness: 4,
      })
      .setOrigin(1, 0);
  }

  #createMeldButton(): void {
    // Button background
    const bg = this.add
      .rectangle(0, 0, 140, 45, 0x4caf50, 1)
      .setStrokeStyle(2, 0x2e7d32)
      .setInteractive({ useHandCursor: true });

    // Button text
    const text = this.add
      .text(0, 0, 'Lay Meld', {
        fontSize: '16px',
        fontFamily: 'Arial',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    // Container for both
    this.#meldButton = this.add.container(this.scale.width / 2, 550, [
      bg,
      text,
    ]);
    this.#meldButton.setVisible(false);

    // Hover effects
    bg.on('pointerover', () => {
      bg.setFillStyle(0x66bb6a);
    });

    bg.on('pointerout', () => {
      bg.setFillStyle(0x4caf50);
    });

    // Click handler
    bg.on('pointerdown', () => {
      this.#onMeldButtonClick();
    });
  }

  #onMeldsLaidDown(event: MeldsLaidDownEvent): void {

    this.#displayPlayerMelds(event.playerIndex, event.melds);


    // Only update human player's UI state
    if (event.playerIndex === 0) {
      this.#selectedCards.clear();
      this.#currentValidation = null;

      this.time.delayedCall(100, () => {
        this.#updateCardsInHand();
        this.#updateDropZonesForHand();
      });

      const message = event.playerHasOpened
        ? `Opened with ${event.meldScore} points! 🎉`
        : `Laid down ${event.melds.length} meld${event.melds.length > 1 ? 's' : ''}!`;

      this.#showMessage(message);
    } else {
      // AI player laid melds
      this.#updatePlayerIconStatus(event.playerIndex, true);
    }
  }

  #createCard(x: number,
    y: number,
    _draggable: boolean,
    cardIndex?: number
  ): Phaser.GameObjects.Image {
    const card = this.add
      .image(x, y, ASSET_KEYS.CARDS, CARD_BACK_FRAME)
      .setOrigin(0)
      .setScale(SCALE)
      .setInteractive()
      .setData({
        x,
        y,
        cardIndex,
      });
    return card;
  }

  #createDropZoneForDiscard(): void {
    let zone = this.add
      .zone(
        LAYOUT.DISCARD_PILE.x - 75,
        LAYOUT.DISCARD_PILE.y - 75,
        CARD_WIDTH * SCALE + 150,
        CARD_HEIGHT * SCALE + 150
      )
      .setOrigin(0)
      .setRectangleDropZone(CARD_WIDTH * SCALE + 150, CARD_HEIGHT * SCALE + 150)
      .setData({
        zoneType: ZONE_TYPE.DISCARD,
      });
  }

  // #onCardDrawnFromDiscard(event: CardDrawnEvent): void {
  //   if (event.playerIndex !== 0) return;

  //   // Similar to #onCardDrawn, but card comes from discard pile
  //   const cardGO = this.#createCardVisual(event.card);
  //   this.#cardsInHand.push(cardGO);

  //   // Animate from discard pile instead of draw pile
  //   this.tweens.add({
  //     targets: cardGO,
  //     x: LAYOUT.PLAYER_HAND.x,
  //     y: LAYOUT.PLAYER_HAND.y,
  //     duration: 300,
  //     ease: 'Back.easeOut',
  //     onComplete: () => {
  //       this.#updateCardsInHand();
  //       this.#updateDropZonesForHand();
  //     }
  //   });

  //   // Update discard pile visual
  //   const state = this.#logic.getState();
  //   if (state.discardPileSize === 0) {
  //     this.#discardPileCard.setVisible(false);
  //   } else if (state.topDiscardCard) {
  //     this.#discardPileCard.setFrame(this.#getCardFrame(state.topDiscardCard));
  //   }
  // }

  #onCardDiscarded(event: CardDiscardedEvent): void {

    if (event.playerIndex === 0) {
      // Human player discarded - remove from visual hand
      // Find and remove the card GameObject
      const cardIndex = this.#cardsInHand.findIndex(
        go => go.getData('cardId') === event.card.id
      );

      if (cardIndex !== -1) {
        const cardGO = this.#cardsInHand[cardIndex];
        this.#cardsInHand.splice(cardIndex, 1);

        // Animate to discard pile
        this.tweens.add({
          targets: cardGO,
          x: LAYOUT.DISCARD_PILE.x,
          y: LAYOUT.DISCARD_PILE.y,
          duration: 100,
          ease: 'Power2',
          onComplete: () => {
            cardGO.destroy();
            this.#updateCardsInHand();
            this.#updateDropZonesForHand();
          }
        });
      }
    }
    // Update discard pile visual for all players
    this.#discardPileCard.setFrame(this.#getCardFrame(event.card));
    this.#discardPileCard.setVisible(true);
    this.#updatePlayerCardCount(event.playerIndex, event.handSize);
  }

  #createDrawPile(): void {
    this.#drawPileCards = [];
    for (let i = 0; i < 3; i += 1) {
      this.#drawPileCards.push(
        this.#createCard(LAYOUT.DRAW_PILE.x + i * 10, LAYOUT.DRAW_PILE.y, false)
      );
    }
    const drawZone = this.add
      .zone(
        LAYOUT.DRAW_PILE.x - 10,
        LAYOUT.DRAW_PILE.y - 10,
        CARD_WIDTH * SCALE + 40,
        CARD_HEIGHT * SCALE + 30
      )
      .setOrigin(0)
      .setInteractive();
    drawZone.on(Phaser.Input.Events.POINTER_DOWN, () => {
      this.#logic.drawCard(0);
    });
  }

  // inside game-scene.ts class GameScene

  #runAITurn(): void {
    const aiIndex = this.#logic.getState().currentPlayer;

    if (aiIndex === 0) return; // Safety check

    // 1. AI "Thinks" about Drawing
    this.time.delayedCall(500, () => {
      // AI decides source
      const drawFromDiscard = this.#ai.shouldDrawFromDiscard(this.#logic, aiIndex);

      if (drawFromDiscard) {
        this.#logic.drawFromDiscard(aiIndex);
      } else {
        this.#logic.drawCard(aiIndex);
      }

      // 2. AI "Thinks" about Melding and Discarding
      // We add a delay to simulate thought and let the draw animation finish
      this.time.delayedCall(1000, () => {
        
        // This calculates the BEST move based on the hand AFTER drawing
        const plan = this.#ai.planMeldAndDiscard(this.#logic, aiIndex);

        // A. Lay Melds (if any)
        if (plan.meldsToLay.length > 0) {
          const success = this.#logic.layDownMelds(aiIndex, plan.meldsToLay);
          if (!success) {
            console.warn(`AI Player ${aiIndex} tried to lay invalid melds. Logic rejected it.`);
          }
        }

        // B. Attempt to add cards to existing melds (optional Advanced feature)
        // You can add logic here to check `this.#logic.getPlayerMelds(aiIndex)`
        // and see if `plan.cardToDiscard` or others fit there.

        // C. Discard
        this.time.delayedCall(500, () => {
          // Ensure the card to discard is actually in hand (safety check)
          const currentHand = this.#logic.getPlayerHand(aiIndex);
          const cardInHand = currentHand.find(c => c.id === plan.cardToDiscard.id);
          
          if (cardInHand) {
            this.#logic.discardCard(aiIndex, cardInHand);
          } else {
            // Fallback if planning went wrong
            this.#logic.discardCard(aiIndex, currentHand[0]);
          }
        });
      });
    });
  }

  #showMessage(text: string): void {
    const message = this.add
      .text(this.scale.width / 2, this.scale.height / 2 + 100, text, {
        fontSize: "24px",
        fontFamily: "Arial",
        color: "#000000",
        //backgroundColor: "#000000",
        padding: { x: 20, y: 10 },
      })
      .setOrigin(0.5)
      .setDepth(1000);

    this.tweens.add({
      targets: message,
      alpha: 0,
      y: message.y - 30,
      duration: 2000,
      ease: "Power2",
      onComplete: () => message.destroy(),
    });
  }
  #getCardFrame(data: Card): number {
    if (data.value === 14) {
      return data.suit === "JOKER_RED" ? 52 : 53;
    }
    return SUIT_FRAMES[data.suit] + data.value - 1;
  }
}