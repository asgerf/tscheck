module A {
	export var x : number = 5;
	export interface I { a : number; }
}
module B {
	export import X = A;
	export var w : number = 5;
}

var z : B.X.I = { a: 5 }

module B {
	var z : X.I = { a: 5 }
}