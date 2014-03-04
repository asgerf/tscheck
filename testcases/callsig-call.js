function foo(x, y) {
	return bar(x, y);
}
function bar(x, y) {
	baz(x, y);
	return x.f;
}
function baz(x, y) {
	x.f = y;
}

function good(x) {
	var obj = {};
	return foo(obj, x);	
}
function bad(x) {
	var obj = {};
	return foo(obj, x);	
}
