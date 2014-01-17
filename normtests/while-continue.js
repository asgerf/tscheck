var foo = ['foo','bar',null,'baz'];
var x = '';
var i=-1;
while (i < foo.length-1) {
	i++;
	if (!foo[i])
		continue;
	x += foo[i];
}
console.log(x);
