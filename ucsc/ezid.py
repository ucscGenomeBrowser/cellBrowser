#! /usr/bin/env python

# EZID command line client.  Input metadata (from command line
# parameters and files) is assumed to be UTF-8 encoded, and output
# metadata is UTF-8 encoded, unless overriden by the -e option.  By
# default, ANVL responses (currently, that's all responses) are left
# in %-encoded form.
#
# Usage: ezid.py [options] credentials operation...
#
#   options:
#     -d          decode ANVL responses
#     -e ENCODING character encoding; defaults to UTF-8
#     -o          one line per ANVL value: convert newlines to spaces
#     -t          format timestamps
#
#   credentials:
#     username:password
#     username (password will be prompted for)
#     sessionid=... (as returned by previous login)
#     - (none)
#
#   operation:
#     m[int] shoulder [element value ...]
#     c[reate][!] identifier [element value ...]
#       create! = create or update
#     v[iew][!] identifier
#       view! = match longest identifier prefix
#     u[pdate] identifier [element value ...]
#     d[elete] identifier
#     login
#     logout
#     s[tatus]
#
# In the above, if an element is "@", the subsequent value is treated
# as a filename and metadata elements are read from the named
# ANVL-formatted file.  For example, if file metadata.txt contains:
#
#   erc.who: Proust, Marcel
#   erc.what: Remembrance of Things Past
#   erc.when: 1922
#
# then an identifier with that metadata can be minted by invoking:
#
#   ezid.py username:password mint ark:/99999/fk4 @ metadata.txt
#
# Otherwise, if a value has the form "@filename", a (single) value is
# read from the named file.  For example, if file metadata.xml
# contains a DataCite XML record, then an identifier with that record
# as the value of the 'datacite' element can be minted by invoking:
#
#   ezid.py username:password mint doi:10.5072/FK2 datacite @metadata.xml
#
# In both of the above cases, the interpretation of @ can be defeated
# by doubling it.
#
# Greg Janee <gjanee@ucop.edu>
# May 2013

import codecs
import getpass
import optparse
import re
import sys
import time
import types
import urllib
import urllib2

KNOWN_SERVERS = {
  "p": "https://ezid.cdlib.org"
}

OPERATIONS = {
  # operation: (number of arguments, accepts bang)
  "mint": (lambda l: l%2 == 1, False),
  "create": (lambda l: l%2 == 1, True),
  "view": (1, True),
  "update": (lambda l: l%2 == 1, False),
  "delete": (1, False),
  "login": (0, False),
  "logout": (0, False),
  "status": (0, False)
}

USAGE_TEXT = """Usage: ezid.py [options] credentials operation...

  options:
    -d          decode ANVL responses
    -e ENCODING character encoding; defaults to UTF-8
    -o          one line per ANVL value: convert newlines to spaces
    -t          format timestamps

  credentials:
    username:password
    username (password will be prompted for)
    sessionid=... (as returned by previous login)
    - (none)

  operation:
    m[int] shoulder [element value ...]
    c[reate][!] identifier [element value ...]
      create! = create or update
    v[iew][!] identifier
      view! = match longest identifier prefix
    u[pdate] identifier [element value ...]
    d[elete] identifier
    login
    logout
    s[tatus]
"""

# Global variables that are initialized farther down.

_options = None
_server = None
_opener = None
_cookie = None

class MyHelpFormatter (optparse.IndentedHelpFormatter):
  def format_usage (self, usage):
    return USAGE_TEXT

class MyHTTPErrorProcessor (urllib2.HTTPErrorProcessor):
  def http_response (self, request, response):
    # Bizarre that Python leaves this out.
    if response.code == 201:
      return response
    else:
      return urllib2.HTTPErrorProcessor.http_response(self, request, response)
  https_response = http_response

def formatAnvlRequest (args):
  request = []
  for i in range(0, len(args), 2):
    k = args[i].decode(_options.encoding)
    if k == "@":
      f = codecs.open(args[i+1], encoding=_options.encoding)
      request += [l.strip("\r\n") for l in f.readlines()]
      f.close()
    else:
      if k == "@@":
        k = "@"
      else:
        k = re.sub("[%:\r\n]", lambda c: "%%%02X" % ord(c.group(0)), k)
      v = args[i+1].decode(_options.encoding)
      if v.startswith("@@"):
        v = v[1:]
      elif v.startswith("@") and len(v) > 1:
        f = codecs.open(v[1:], encoding=_options.encoding)
        v = f.read()
        f.close()
      v = re.sub("[%\r\n]", lambda c: "%%%02X" % ord(c.group(0)), v)
      request.append("%s: %s" % (k, v))
  return "\n".join(request)

def encode (id):
  return urllib.quote(id, ":/")

def issueRequest (path, method, data=None, returnHeaders=False,
  streamOutput=False):
  request = urllib2.Request("%s/%s" % (_server, path))
  request.get_method = lambda: method
  if data:
    request.add_header("Content-Type", "text/plain; charset=UTF-8")
    request.add_data(data.encode("UTF-8"))
  if _cookie: request.add_header("Cookie", _cookie)
  try:
    connection = _opener.open(request)
    if streamOutput:
      while True:
        sys.stdout.write(connection.read(1))
        sys.stdout.flush()
    else:
      response = connection.read()
      if returnHeaders:
        return response.decode("UTF-8"), connection.info()
      else:
        return response.decode("UTF-8")
  except urllib2.HTTPError, e:
    sys.stderr.write("%d %s\n" % (e.code, e.msg))
    if e.fp != None:
      response = e.fp.read()
      if not response.endswith("\n"): response += "\n"
      sys.stderr.write(response)
    sys.exit(1)

def printAnvlResponse (response, sortLines=False):
  response = response.splitlines()
  if sortLines and len(response) >= 1:
    statusLine = response[0]
    response = response[1:]
    response.sort()
    response.insert(0, statusLine)
  for line in response:
    if _options.formatTimestamps and (line.startswith("_created:") or\
      line.startswith("_updated:")):
      ls = line.split(":")
      line = ls[0] + ": " + time.strftime("%Y-%m-%dT%H:%M:%S",
        time.localtime(int(ls[1])))
    if _options.decode:
      line = re.sub("%([0-9a-fA-F][0-9a-fA-F])",
        lambda m: chr(int(m.group(1), 16)), line)
    if _options.oneLine: line = line.replace("\n", " ").replace("\r", " ")
    print line.encode(_options.encoding)

# Process command line arguments.

parser = optparse.OptionParser(formatter=MyHelpFormatter())
parser.add_option("-d", action="store_true", dest="decode", default=False)
parser.add_option("-e", action="store", dest="encoding", default="UTF-8")
parser.add_option("-o", action="store_true", dest="oneLine", default=False)
parser.add_option("-t", action="store_true", dest="formatTimestamps",
  default=False)

_options, args = parser.parse_args()
# Simulate selection of the production server (server selection is not
# supported in this public version of the code).
args.insert(0, "p")
if len(args) < 3: parser.error("insufficient arguments")

_server = KNOWN_SERVERS.get(args[0], args[0])

_opener = urllib2.build_opener(MyHTTPErrorProcessor())
if args[1].startswith("sessionid="):
  _cookie = args[1]
elif args[1] != "-":
  if ":" in args[1]:
    username, password = args[1].split(":", 1)
  else:
    username = args[1]
    password = getpass.getpass()
  h = urllib2.HTTPBasicAuthHandler()
  h.add_password("EZID", _server, username, password)
  _opener.add_handler(h)

if args[2].endswith("!"):
  bang = True
  args[2] = args[2][:-1]
else:
  bang = False
operation = filter(lambda o: o.startswith(args[2]), OPERATIONS)
if len(operation) != 1: parser.error("unrecognized or ambiguous operation")
operation = operation[0]
if bang and not OPERATIONS[operation][1]:
  parser.error("unrecognized operation")

args = args[3:]

if (type(OPERATIONS[operation][0]) is int and\
  len(args) != OPERATIONS[operation][0]) or\
  (type(OPERATIONS[operation][0]) is types.LambdaType and\
  not OPERATIONS[operation][0](len(args))):
  parser.error("incorrect number of arguments for operation")

# Perform the operation.

if operation == "mint":
  shoulder = args[0]
  if len(args) > 1:
    data = formatAnvlRequest(args[1:])
  else:
    data = None
  response = issueRequest("shoulder/"+encode(shoulder), "POST", data)
  printAnvlResponse(response)
elif operation == "create":
  id = args[0]
  if len(args) > 1:
    data = formatAnvlRequest(args[1:])
  else:
    data = None
  path = "id/"+encode(id)
  if bang: path += "?update_if_exists=yes"
  response = issueRequest(path, "PUT", data)
  printAnvlResponse(response)
elif operation == "view":
  id = args[0]
  path = "id/"+encode(id)
  if bang: path += "?prefix_match=yes"
  response = issueRequest(path, "GET")
  printAnvlResponse(response, sortLines=True)
elif operation == "update":
  id = args[0]
  if len(args) > 1:
    data = formatAnvlRequest(args[1:])
  else:
    data = None
  response = issueRequest("id/"+encode(id), "POST", data)
  printAnvlResponse(response)
elif operation == "delete":
  id = args[0]
  response = issueRequest("id/"+encode(id), "DELETE")
  printAnvlResponse(response)
elif operation == "login":
  response, headers = issueRequest("login", "GET", returnHeaders=True)
  response += "\nsessionid=%s\n" %\
    headers["set-cookie"].split(";")[0].split("=")[1]
  printAnvlResponse(response)
elif operation == "logout":
  response = issueRequest("logout", "GET")
  printAnvlResponse(response)
elif operation == "status":
  response = issueRequest("status", "GET")
  printAnvlResponse(response)
