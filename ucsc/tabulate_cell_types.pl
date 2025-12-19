#!/usr/bin/env perl
# File tabulate_cell_types.pl by Marc Perry
# 
# 
# 
# Last Updated: 2024-07-18, Status: in development

use strict;
use warnings;
use JSON;

=head1 NAME

tabulate_cell_types.pl

=head2 INPUT: 

dataset.json a file required to run the UCSC Cell Browser, it contains an aggregate
of all kinds of information from each dataset that has been built
on the alpha, or test (or dev) server for the data wranglers.
This file lives here:
/usr/local/apache/htdocs-cells/dataset.json
Currently, in this version of the Perl script, the path to this file is hardcoded.

=head2 OUTPUT:

One TSV table: "cell-type_table.tsv"

As the subroutines in this script convert the information stored into the top-level
dataset.json file into a list of paths to the desired dataset.json files inside each 
dataset on the test server, the script prints information to STDOUT:

The name of the dataset currently being processed,

The name of the relevant cluster field in the meta.tsv file

The name of the different cell-types being processed in the meta.tsv file

I used this information during development to determine if the parsing algorithm
was working as intended.  I suggest when you run this script you direct that STDOUT
data to a log file (for reference/troubleshooting/debugging).  The script will create
hardcoded file name for it's primary output.

=head3 NOTES:  

The code never queries or parses the cellbrowser.conf files, nor does it query or parse the
meta.tsv files.  Instead, the script parses the requisite dataset.json files in each 
hierarchical level of the apache server directory.

The main subroutine is called recursively to drill down into the datasets and collections.
When it reaches a dataset.json file that does not contain a JSON key named 'datasets', it 
methodically queries each of the three different JSON keys that might store the information
about which field was used for labelling the clusters.  Once it has found that field, it 
continues to extract the names of the "cell-types" stored in appropriate metaField.

Once that information is found, it is stored in a global hash (dictionary), along with the
name of the dataset that used that particular string as a cell-type.

After processing all of the datasets the script iterates over the hash data structure and
prints out each key on a separate line.  The second column contains a CSV list of the 
all the datasets that used the field.


=cut

my $USAGE = "USAGE:\n $0 > logfile.txt\n";

# N.B., this is a global hash data structure
# that gets built up or filled in as the various dataset.json
# files get processed by the script
my %cell_types = ();

my $first_json_path = "/usr/local/apache/htdocs-cells";
my $data = get_json( $first_json_path );

# the first time I call this, I want to get a list of dataset names
# NOTE: We _know_ that this top level file HAS to have datasets so we
# don't need to test that
my $array_ref = get_dataset_names( $data );
my @list_of_datasets = @{$array_ref};

iterate_over_list_of_names( \@list_of_datasets, );

# Send in an array
sub iterate_over_list_of_names {
    # first element passed in is an array ref
    my @list_of_datasets = @{ shift @_ };
    my $current_path = "/usr/local/apache/htdocs-cells";
    foreach my $ds_name ( @list_of_datasets ) {
        my $path_to_json = $current_path . '/' . $ds_name;
        # Now we are going to call, get_json() which gives us back a hashref
        my $decoded = get_json( $path_to_json );

        if ( exists $decoded->{datasets} ) {
            my $dataset_names = get_dataset_names( $decoded );
            my @new_list = @{$dataset_names};
            # recursive function call to this same subroutine
            iterate_over_list_of_names ( \@new_list, );
        }
        elsif ( exists $decoded->{clusterField} ) {
            extract_cell_types( $decoded, $ds_name, 'clusterField', );
        }
        elsif ( exists $decoded->{labelField} ) {
            extract_cell_types( $decoded, $ds_name, 'labelField', );        
        }
        elsif ( exists $decoded->{defColorField} ) {
            extract_cell_types( $decoded, $ds_name, 'defColorField', );        
        }
        else {
            print "Could not find a clusterField OR a labelField OR a defColorField value in cellbrowser.conf for dataset $ds_name\n";
	}
    } # close main foreach loop
} # close sub

open my ($FH), '>', 'cell-type_table.tsv' or die "Could not open file for writing: $!";

print $FH "cell_type\tdataset_count\tdataset_names\n";
foreach my $cell_type ( sort keys %cell_types ) {
    print $FH "$cell_type\t", scalar(@{$cell_types{$cell_type}}), "\t", join(",", @{$cell_types{$cell_type}} ), "\n";
} # close foreach loop

close $FH;

exit;

# We only call this one when we know that we have arrived at a dataset.json file
# that contains NO key named datasets.
sub extract_cell_types {
    my %dataset = %{ shift @_ };
    my $dataset_name = shift;
    my $meta_field = shift;
    print "\$dataset_name contains: $dataset_name\n";
    my $cluster = $dataset{$meta_field};
    if ( $cluster ) {
        print "\t\$cluster contains: $cluster\n";
        foreach my $field ( @{$dataset{metaFields}} ) {
            if ( $field->{label} eq $cluster ) {
                if (exists $field->{valCounts} ) {
                    my @values = @{ $field->{valCounts} };
                    foreach my $value ( @values ) {
                        my $cell_type = $value->[0];
                        if ( $cell_type ) {
                            print "\t\t\$cell_type contains: $cell_type\n";
                            push( @{$cell_types{$cell_type}}, $dataset_name, ); 
                        }
                        else {
                            next;
                        }
                    } # close inner foreach loop
                }
                else {
                    print "\t\t\$cluster named $cluster does not contain any valCounts!! WTF?\n";
		}
            }
            else { 
                next;
            }
        } # close outer foreach loop
    }
    else {
        print "\t\$cluster was uninitialized for \$dataset_name: $dataset_name\n";
    }
} # close sub


# INPUT, a hashref
# OUTPUT, an arrayref
sub get_dataset_names {
    my $data = shift;
    my @dataset_names = ();
    # Iterating over the array of Perl hashes
    foreach my $dataset ( @{$data->{datasets}} ) {
        # extracting the UCSC Cell Browser dataset name for the current dataset
        my $name = $dataset->{name};
        push( @dataset_names, $name, );
    } # close foreach;
    return \@dataset_names;
} # close sub


# INPUT: a directory path
# OUTPUT: a hashref
sub get_json {
    my $path_to_json = shift;
    my $json_file = $path_to_json . '/dataset.json';
    unless ( -e -f -r $json_file ) {
        die "The JSON document you are trying to access, $json_file,  either does not exist, is not a file, or is not readable\n";
    }

    open my ($FH), '<', $json_file or die "Could not open $json_file";

    my $json_lines = q{};
    while ( <$FH> ) {
        $json_lines .= $_;
    }
    close $FH;
    my $data = decode_json( $json_lines );
    return $data;
} # close sub

__END__
