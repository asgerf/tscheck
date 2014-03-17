module PIXI {
	export class Point
	{
		x: number;
		y: number;
		constructor(x: number, y: number);
	}

	export class Polygon
	{
		points: Point[];

		constructor(points: Point[]);
		constructor(points: number[]);
		constructor(...points: Point[]);
		constructor(...points: number[]);
	}
}

declare function bad(): PIXI.Polygon;
