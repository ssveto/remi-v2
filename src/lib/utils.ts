export function shuffleArray<T>(array: T[]): void {
    // fisher yates shuffle algo
    for (let i = array.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * i);
        const temp = array[i]
        array[i] = array[j];
        array[j] = temp;
    }
}

export function exhaustiveGuard(_value: never): never {
    throw new Error(`Error! Reached forbidden guard function with unexpected value: ${JSON.stringify(_value)}`);
}

