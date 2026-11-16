# NOTICE

This entry reimplements, in fresh code written for this competition, the
Markdown rendering behaviour of **marked 18.1.3** (MIT). Its block and
inline grammars are reproduced from marked's own regexes so that the
output is byte-identical to `marked.parse(markdown)` with marked's default
options (gfm on, breaks off, pedantic off, async off). It is not a copy of
marked's source: the lexer, parser and renderer were written from the
algorithm, and the grammar tables were composed from the same small pieces
marked composes them from. The competition's rules explicitly allow forking
marked under its licence, credited.

marked's licence (MIT), as shipped in its repository:

> Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
> Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.

This entry's own code is licensed under the MIT License; see LICENSE.

SPDX-License-Identifier: MIT
