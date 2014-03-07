function Foo() {
}
Foo.prototype.g = function() {
	return "dfg";
}
function Bar() {
}
Bar.prototype.g = function() {
	return 45;
}

function good(x) {
	var z = new Foo;
	if (x) {
		z = new Bar
	}
	return z.g();
}
var good2 = good;
var bad = good;
