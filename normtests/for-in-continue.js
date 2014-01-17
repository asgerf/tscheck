var obj = {
	foo: 'x',
	bar: 'y',
	baz: 'w'
}
var x = '';
for (var k in obj) {
	if (k[0] !== 'b')
		continue;
	x += k + obj[k];
}
console.log(x);
