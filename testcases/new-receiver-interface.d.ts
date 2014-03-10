declare interface Obj {
	x: number;
	foo(): {new(): Obj};
}

declare var good : Obj;
declare var bad : string;
