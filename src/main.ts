import * as Phaser from 'phaser';
import { PreloadScene } from './scenes/preload-scene';
import { TitleScene } from './scenes/title-scene';
import { GameScene } from './scenes/game-scene';

const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  //pixelArt: true,
  scale: {
    parent: 'game-container',
    // width: 640,
    // height: 360,
    width: 1280,
    height: 720,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    mode: Phaser.Scale.FIT,
  },
  input: {
    activePointers: 3,
    touch: true,
    smoothFactor: 0,
    windowEvents: true,
  },
  backgroundColor: '#2E8B57',
  scene: [PreloadScene, TitleScene, GameScene],
};

window.onload = () => {
  new Phaser.Game(gameConfig);
};
