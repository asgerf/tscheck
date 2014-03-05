function A() {
	return {next:B};
}
function B() {
	return {next:C};
}
function C() {
	return 5;
}
function good() {
	var x = {next:A};
	while (x.next) {
		x = x.next();
	}
	return x;
}
var bad = good;

