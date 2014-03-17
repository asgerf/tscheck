function good() {
	return new Float32Array(9);
}
var bad = good;

console.log('good = ' + good())