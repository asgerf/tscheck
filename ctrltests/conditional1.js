var SC_ID_CLASS = "abcdefghijklmnopqrstuvwxyz"
function isIdOrNumberChar(c) {
	return SC_ID_CLASS.indexOf(c) != -1 || // ID-char
	    (c >= "0" && c <= "9");
}

console.log(isIdOrNumberChar('a'))
console.log(isIdOrNumberChar('5'))
console.log(isIdOrNumberChar('?'))
console.log(isIdOrNumberChar('.'))
