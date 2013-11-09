declare module A {
	var x : number;
}
declare var z : typeof A;

var q = z.x;
