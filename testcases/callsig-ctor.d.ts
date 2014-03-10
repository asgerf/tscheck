declare class good {
	x: number;
	y: string;
	constructor(x:number);

	getX(): number;
	getY(): string;
}

declare class bad {
	x: number;
	y: string;
	constructor(x:string);

	getX(): number;
	getY(): string;
	getW(): boolean;
}
