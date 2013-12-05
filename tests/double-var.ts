declare var x : {
	foo : number;
}
declare module x {
	var bar : number;
}

var a : number = x.foo;
var b : number = x.bar;
