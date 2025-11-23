import * as Phaser from 'phaser';
import { ASSET_KEYS, CARD_HEIGHT, CARD_WIDTH, SCENE_KEYS } from './common';

export class PreloadScene extends Phaser.Scene {
  constructor() {
    super({ key: SCENE_KEYS.PRELOAD });
  }

  public preload(): void {
    
    this.load.spritesheet(ASSET_KEYS.CARDS, '/public/assets/images/spritesheet2.png', {
         frameWidth: CARD_WIDTH,
         frameHeight: CARD_HEIGHT,
    });
  }

  public create(): void {
    this.scene.start(SCENE_KEYS.TITLE);
  }
}
