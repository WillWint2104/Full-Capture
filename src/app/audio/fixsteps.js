// Plain-language Windows steps for the problems a sound check can find.
// Shown under "How to fix this in Windows" when the verdict isn't green.

export const SOUND_SETTINGS_URL = 'ms-settings:sound';

const STEPS = {
  pickMic: {
    win11: 'Open Settings › System › Sound. Under Input, choose your headset microphone.',
    win10: 'Open Settings › System › Sound. Under Input, choose your headset microphone.',
  },
  raiseVolume: {
    win11: 'In Settings › System › Sound › Input, click your microphone and set Input volume to 80–100.',
    win10: 'In Settings › System › Sound › Input, click Device properties and set Volume to 80–100.',
  },
  lowerVolume: {
    win11: 'In Settings › System › Sound › Input, click your microphone and lower Input volume to about 70.',
    win10: 'In Settings › System › Sound › Input, click Device properties and lower Volume to about 70.',
  },
  boostOff: {
    win11: 'For hiss: Settings › System › Sound › More sound settings › Recording › your microphone › Properties › Levels › set Microphone Boost to 0.',
    win10: 'For hiss: Settings › System › Sound › Sound Control Panel › Recording › your microphone › Properties › Levels › set Microphone Boost to 0.',
  },
  closer: {
    win11: 'Keep the microphone a hand-span from your mouth and speak at your normal teaching voice.',
    win10: 'Keep the microphone a hand-span from your mouth and speak at your normal teaching voice.',
  },
  quieterRoom: {
    win11: 'Turn off fans or air conditioning, and close the door and windows.',
    win10: 'Turn off fans or air conditioning, and close the door and windows.',
  },
};

/**
 * Steps tailored to a sound-check result (or general advice without one).
 * @returns {{ win11: string[], win10: string[] }}
 */
export function fixSteps(result) {
  const keys = [];
  if (!result) keys.push('pickMic', 'raiseVolume', 'boostOff');
  else if (result.status === 'clipping') keys.push('lowerVolume', 'boostOff');
  else if (result.status === 'novoice') keys.push('pickMic', 'raiseVolume', 'closer');
  else {
    if (result.voiceFaint || result.voice?.level !== 'good') keys.push('closer', 'raiseVolume');
    if (result.background?.level !== 'good') keys.push(result.roomQuiet ? 'boostOff' : 'quieterRoom', ...(result.roomQuiet ? [] : ['boostOff']));
    if (!keys.length) keys.push('pickMic', 'raiseVolume');
  }
  const unique = [...new Set(keys)];
  return {
    win11: unique.map(k => STEPS[k].win11),
    win10: unique.map(k => STEPS[k].win10),
  };
}

/** The steps as plain text for "Copy these steps". */
export function fixStepsText(result) {
  const { win11, win10 } = fixSteps(result);
  const list = steps => steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `Fix my microphone in Windows\n\nWindows 11:\n${list(win11)}\n\nWindows 10:\n${list(win10)}\n`;
}
