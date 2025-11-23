All the javascript code is located under src/cbPyLib/cellbrowser/cbWeb/js/
(css etc are in directories not to js)

Git clone this repo and make changes to the files

Then run 'cbUpgrade --dev --code' to package all the css/js files together into the htdocs directory.
Either set this directory with -o to cbUpgrade, via the CBOUT variable or in the ~/.cellbrowser file
with the configuration statement 'htmlDir', e.g. 'htmlDir="/var/www/"' or 'htmlDir="~/public_html/cells"'.
